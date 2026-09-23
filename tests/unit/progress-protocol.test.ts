import { describe, it, expect } from 'vitest'
import {
  PROGRESS_BLOCK_LIMITS,
  PROGRESS_TAG_KINDS,
  TurnProgressProjector,
  extractProgressUpdates,
  normalizeProgressBlock,
  stripProgressBlocks,
  unwrapProgressTags,
} from '../../src/main/ipc/progress-protocol'

describe('progress protocol', () => {
  describe('extractProgressUpdates', () => {
    it('recognizes the structured plan and step kinds', () => {
      const content = [
        '<eva-progress kind="plan">1. 先确认写入路径\n2. 修复去重逻辑</eva-progress>',
        '<eva-progress kind="step">修复完成，测试通过。</eva-progress>',
      ].join('\n')

      expect(extractProgressUpdates(content)).toEqual([
        { kind: 'plan', content: '1. 先确认写入路径\n2. 修复去重逻辑' },
        { kind: 'step', content: '修复完成，测试通过。' },
      ])
    })

    it('keeps the legacy kinds working and defaults an untyped tag to thinking', () => {
      const content = [
        '<eva-progress kind="finding">找到重复写入点</eva-progress>',
        '<eva-progress>准备读取目录</eva-progress>',
      ].join('')

      expect(extractProgressUpdates(content)).toEqual([
        { kind: 'finding', content: '找到重复写入点' },
        { kind: 'thinking', content: '准备读取目录' },
      ])
    })

    it('carries the plan line a step completed, when the model names one', () => {
      const content = [
        '<eva-progress kind="plan">确认写入路径\n修复去重逻辑</eva-progress>',
        '<eva-progress kind="step" item="1">已确认三处写入路径。</eva-progress>',
        '<eva-progress kind="step">无编号的历史写法仍然可用。</eva-progress>',
      ].join('\n')

      expect(extractProgressUpdates(content)).toEqual([
        { kind: 'plan', content: '确认写入路径\n修复去重逻辑' },
        { kind: 'step', content: '已确认三处写入路径。', item: 1 },
        { kind: 'step', content: '无编号的历史写法仍然可用。' },
      ])
    })

    it('reads attributes in any order so a report is never dropped', () => {
      const updates = extractProgressUpdates('<eva-progress item="2" kind="step">去重逻辑已修复。</eva-progress>')

      expect(updates).toEqual([{ kind: 'step', content: '去重逻辑已修复。', item: 2 }])
    })

    it('ignores a non-positive item instead of inventing a tick', () => {
      expect(extractProgressUpdates('<eva-progress kind="step" item="0">完成。</eva-progress>')).toEqual([
        { kind: 'step', content: '完成。' },
      ])
    })

    it('keeps a multi-line plan as lines instead of flattening it into one paragraph', () => {
      const plan = '1. 先确认写入路径，判断是否存在重复写入\n2. 修复去重逻辑并补测试\n3. 跑全量测试验证'

      const [update] = extractProgressUpdates(`<eva-progress kind="plan">${plan}</eva-progress>`)

      expect(update.content).toBe(plan)
      expect(update.content.split('\n')).toHaveLength(3)
      expect(update.content).not.toBe(plan.replace(/\n/g, ' '))
    })

    it('gives plan and step reports their own length budget instead of the legacy one', () => {
      const long = '步'.repeat(1200)

      const [step] = extractProgressUpdates(`<eva-progress kind="step">${long}</eva-progress>`)
      expect(step.content.length).toBe(PROGRESS_BLOCK_LIMITS.step! + 3)
      expect(step.content.endsWith('...')).toBe(true)

      const [plan] = extractProgressUpdates(`<eva-progress kind="plan">${long}</eva-progress>`)
      expect(plan.content.length).toBe(PROGRESS_BLOCK_LIMITS.plan! + 3)
    })

    it('trims edge whitespace while collapsing only horizontal runs and blank-line runs', () => {
      expect(normalizeProgressBlock('  a   b\n\n\n\nc  ', 200)).toBe('a b\n\nc')
      expect(normalizeProgressBlock('   ', 200)).toBeUndefined()
      expect(normalizeProgressBlock(undefined, 200)).toBeUndefined()
    })

    it('masks credential-shaped text before publishing a report', () => {
      const [update] = extractProgressUpdates('<eva-progress kind="step">导出 API_KEY=sk-live-123456 完成</eva-progress>')

      expect(update.content).toContain('API_KEY=[已隐藏]')
      expect(update.content).not.toContain('sk-live-123456')
    })
  })

  describe('answer scrubbing', () => {
    const tagged = (kind: string) => `前文 <eva-progress kind="${kind}">过程文本</eva-progress> 后文`

    it('registers every kind the extractor knows about', () => {
      // A kind missing from the shared list would leak its raw markup into the
      // persisted answer, so the scrubbing regexes are built from it.
      const kinds = PROGRESS_TAG_KINDS.split('|')
      for (const kind of kinds) {
        const cleaned = stripProgressBlocks(tagged(kind))
        expect(cleaned).not.toContain('<eva-progress')
        expect(cleaned).not.toContain('过程文本')
      }
      expect(kinds).toEqual(expect.arrayContaining(['plan', 'step']))
    })

    it('strips an untyped block too', () => {
      expect(stripProgressBlocks('前文 <eva-progress>过程文本</eva-progress> 后文')).not.toContain('<eva-progress')
    })

    it('strips a block carrying an item attribute in either attribute order', () => {
      for (const markup of [
        '<eva-progress kind="step" item="2">过程文本</eva-progress>',
        '<eva-progress item="2" kind="step">过程文本</eva-progress>',
      ]) {
        const cleaned = stripProgressBlocks(`前文 ${markup} 后文`)
        expect(cleaned).not.toContain('<eva-progress')
        expect(cleaned).not.toContain('过程文本')
      }
    })

    it('keeps the inner text when unwrapping so scrubbing cannot empty a real reply', () => {
      const wrapped = '<eva-progress kind="plan">这就是真正的回复</eva-progress>'

      expect(stripProgressBlocks(wrapped).trim()).toBe('')
      expect(unwrapProgressTags(wrapped).trim()).toBe('这就是真正的回复')
    })
  })

  describe('TurnProgressProjector', () => {
    it('forwards ordinary text as soon as it arrives, chunk by chunk', () => {
      const projector = new TurnProgressProjector()

      expect(projector.feed('你好，我')).toEqual([{ type: 'text', content: '你好，我' }])
      expect(projector.feed('看一下。')).toEqual([{ type: 'text', content: '看一下。' }])
    })

    it('holds a tag opener split across chunks instead of leaking it as text', () => {
      const projector = new TurnProgressProjector()

      expect(projector.feed('前文 <eva-pro')).toEqual([{ type: 'text', content: '前文 ' }])
      expect(projector.feed('gress kind="step">完成</eva-progress>后文')).toEqual([
        { type: 'progress', kind: 'step', content: '完成' },
        { type: 'text', content: '后文' },
      ])
    })

    it('keeps answer text and reports in the order the model produced them', () => {
      const projector = new TurnProgressProjector()

      expect(projector.feed([
        '先读目录',
        '<eva-progress kind="plan">确认写入路径\n修复去重</eva-progress>',
        '<eva-progress kind="step" item="1">已确认三处写入路径。</eva-progress>',
        '最终回复',
      ].join(''))).toEqual([
        { type: 'text', content: '先读目录' },
        { type: 'progress', kind: 'plan', content: '确认写入路径\n修复去重' },
        { type: 'progress', kind: 'step', content: '已确认三处写入路径。', item: 1 },
        { type: 'text', content: '最终回复' },
      ])
    })

    it('keeps an unclosed report pending so half a card is never published', () => {
      const projector = new TurnProgressProjector()

      expect(projector.feed('<eva-progress kind="step">写到一半')).toEqual([])
      // The closer may arrive in a later chunk; then the report is emitted once.
      expect(projector.feed('，继续写</eva-progress>')).toEqual([
        { type: 'progress', kind: 'step', content: '写到一半，继续写' },
      ])
    })

    it('reads streamed attributes in any order so a report is never dropped', () => {
      const projector = new TurnProgressProjector()

      expect(projector.feed('<eva-progress item="2" kind="step">去重逻辑已修复。</eva-progress>')).toEqual([
        { type: 'progress', kind: 'step', content: '去重逻辑已修复。', item: 2 },
      ])
    })

    it('drops an incomplete fragment when a tool cycle interrupts the stream', () => {
      const projector = new TurnProgressProjector()
      projector.feed('正文 <eva-progress kind="step">未闭合的过程')

      projector.discardPending()

      expect(projector.feed('新周期的正文')).toEqual([{ type: 'text', content: '新周期的正文' }])
    })
  })
})
