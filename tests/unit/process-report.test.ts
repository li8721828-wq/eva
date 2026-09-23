import { describe, it, expect } from 'vitest'
import { buildProcessFeed, isInternalToolLifecycleUpdate, isStructuredReport, processReportLabel } from '../../src/renderer/lib/process-report'
import { buildPlanChecklist, splitPlanLines } from '../../src/shared/plan-checklist'
import type { ProgressUpdate, ProgressUpdateKind } from '../../src/shared/types/conversation'

const update = (id: string, kind: ProgressUpdateKind, content: string, item?: number): ProgressUpdate => ({
  id,
  kind,
  content,
  ...(item ? { item } : {}),
  timestamp: 0,
})

const PLAN = update('p1', 'plan', '1. 确认重复写入\n2. 修复去重逻辑\n3. 跑全量测试')

describe('buildProcessFeed', () => {
  it('lifts the plan out of the sequence and keeps the remaining reports in order', () => {
    const feed = buildProcessFeed([
      update('u1', 'finding', '找到重复写入点'),
      PLAN,
      update('u2', 'step', '修复完成'),
      update('u3', 'step', '测试通过'),
    ])

    expect(feed.plan?.content).toBe(PLAN.content)
    expect(feed.entries.map((entry) => entry.id)).toEqual(['u1', 'u2', 'u3'])
  })

  it('numbers step reports only, so legacy updates never shift the ordinals', () => {
    const feed = buildProcessFeed([
      update('u1', 'thinking', '准备读取目录'),
      update('u2', 'step', '读完了'),
      update('u3', 'finding', '发现重复'),
      update('u4', 'step', '改完了'),
    ])

    expect(feed.entries.map((entry) => [entry.id, entry.stepNumber])).toEqual([
      ['u1', undefined],
      ['u2', 1],
      ['u3', undefined],
      ['u4', 2],
    ])
  })

  it('omits ordinals when the row is a fragment without its sequence', () => {
    const feed = buildProcessFeed([update('u1', 'step', '读完了')], { numberSteps: false })

    expect(feed.entries[0].stepNumber).toBeUndefined()
    expect(processReportLabel(feed.entries[0])).toBe('步骤汇报')
  })

  it('drops internal runner notices from the feed', () => {
    const feed = buildProcessFeed([
      update('u1', 'thinking', 'Preparing the response and any required tools...'),
      update('u2', 'step', '读完了'),
    ])

    expect(feed.entries.map((entry) => entry.id)).toEqual(['u2'])
  })

  it('reports an empty feed when nothing is publishable', () => {
    const feed = buildProcessFeed([])

    expect(feed.plan).toBeUndefined()
    expect(feed.entries).toEqual([])
  })
})

describe('splitPlanLines', () => {
  it('drops the model list markers because the interface numbers the items', () => {
    expect(splitPlanLines('1. 确认重复写入\n- 修复去重逻辑\n（3）跑全量测试\n\n  \n')).toEqual([
      '确认重复写入',
      '修复去重逻辑',
      '跑全量测试',
    ])
  })

  it('keeps a plain multi-line block as one item per line', () => {
    expect(splitPlanLines('确认写入路径\n修复去重逻辑并补测试')).toEqual(['确认写入路径', '修复去重逻辑并补测试'])
  })
})

describe('buildPlanChecklist', () => {
  const ticks = (updates: ProgressUpdate[]) => buildPlanChecklist(updates)?.items.map((item) => item.done)

  it('returns nothing until the run publishes a plan', () => {
    expect(buildPlanChecklist([update('u1', 'step', '先做了一件事')])).toBeUndefined()
  })

  it('ticks the line a step names, in any order', () => {
    const checklist = buildPlanChecklist([
      PLAN,
      update('s2', 'step', '去重逻辑已修复', 2),
      update('s1', 'step', '重复写入已确认', 1),
    ])!

    expect(checklist.items.map((item) => item.text)).toEqual(['确认重复写入', '修复去重逻辑', '跑全量测试'])
    expect(checklist.items.map((item) => item.done)).toEqual([true, true, false])
    expect(checklist.items[1].completedByStepId).toBe('s2')
    expect(checklist.revised).toBe(false)
  })

  it('consumes the next unticked line when a step carries no item', () => {
    expect(ticks([PLAN, update('s1', 'step', '确认完成'), update('s2', 'step', '修复完成')])).toEqual([true, true, false])
  })

  it('falls back to the next unticked line when the named item is stale or out of range', () => {
    expect(ticks([PLAN, update('s1', 'step', '确认完成', 1), update('s2', 'step', '重复引用旧编号', 1)])).toEqual([true, true, false])
    expect(ticks([PLAN, update('s9', 'step', '越界编号', 9)])).toEqual([true, false, false])
  })

  it('counts steps that arrive with nothing left to tick', () => {
    const checklist = buildPlanChecklist([
      PLAN,
      update('s1', 'step', '一'),
      update('s2', 'step', '二'),
      update('s3', 'step', '三'),
      update('s4', 'step', '计划之外的补充汇报'),
    ])!

    expect(checklist.overflowStepCount).toBe(1)
    expect(checklist.items.map((item) => item.done)).toEqual([true, true, true])
  })

  it('restarts the list on a plan revision', () => {
    const revisedPlan = update('p2', 'plan', '改为只补测试\n跳过重构')
    const checklist = buildPlanChecklist([
      PLAN,
      update('s1', 'step', '确认完成', 1),
      revisedPlan,
      update('s2', 'step', '测试已补', 2),
    ])!

    expect(checklist.revised).toBe(true)
    expect(checklist.items.map((item) => item.text)).toEqual(['改为只补测试', '跳过重构'])
    expect(checklist.items.map((item) => item.done)).toEqual([false, true])
  })

  it('exposes the same checklist through the feed so the note and the bubble agree', () => {
    const feed = buildProcessFeed([PLAN, update('s1', 'step', '确认完成', 1)])

    expect(feed.checklist?.items.map((item) => [item.text, item.done])).toEqual([
      ['确认重复写入', true],
      ['修复去重逻辑', false],
      ['跑全量测试', false],
    ])
  })
})

describe('processReportLabel', () => {
  it('labels the structured report and the legacy kinds', () => {
    expect(processReportLabel({ id: 'p', kind: 'plan', content: '' })).toBe('执行计划')
    expect(processReportLabel({ id: 's', kind: 'step', content: '', stepNumber: 2 })).toBe('第 2 步')
    expect(processReportLabel({ id: 'f', kind: 'finding', content: '' })).toBe('发现')
    expect(processReportLabel({ id: 'a', kind: 'action', content: '' })).toBe('处理')
    expect(processReportLabel({ id: 'i', kind: 'issue', content: '' })).toBe('问题')
    expect(processReportLabel({ id: 't', kind: 'thinking', content: '' })).toBe('进展')
  })
})

describe('isStructuredReport', () => {
  it('separates the work report from the legacy free-form kinds', () => {
    expect(isStructuredReport('plan')).toBe(true)
    expect(isStructuredReport('step')).toBe(true)
    expect(isStructuredReport('thinking')).toBe(false)
    expect(isStructuredReport('finding')).toBe(false)
  })
})

describe('isInternalToolLifecycleUpdate', () => {
  it('recognizes runner lifecycle chatter but not real reports', () => {
    expect(isInternalToolLifecycleUpdate('Reviewing the tool results...')).toBe(true)
    expect(isInternalToolLifecycleUpdate('Continuing with an expanded budget of 30 tool cycles...')).toBe(true)
    expect(isInternalToolLifecycleUpdate('修复完成，测试通过。')).toBe(false)
  })
})
