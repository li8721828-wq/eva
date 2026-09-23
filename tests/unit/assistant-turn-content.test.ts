import { describe, expect, it } from 'vitest'
import { resolveAssistantTurnContent } from '../../src/main/services/assistant-turn-content'

describe('resolveAssistantTurnContent', () => {
  it('stores a completed reply unchanged', () => {
    expect(resolveAssistantTurnContent({ completedContent: '  完整的回复。\n' })).toBe('  完整的回复。\n')
  })

  it('labels a failed round that produced nothing instead of storing an empty reply', () => {
    const content = resolveAssistantTurnContent({ completedContent: '', runError: 'socket hang up' })

    expect(content).not.toBe('')
    expect(content).toContain('本次回复未完成')
  })

  it('keeps the half-written prefix the user saw and marks it incomplete', () => {
    const content = resolveAssistantTurnContent({
      completedContent: '## 架构问题\n\n1. 加购流程缺少',
      runError: 'The model did not produce a final answer from the completed tool results.',
    })

    expect(content.startsWith('## 架构问题')).toBe(true)
    expect(content).toContain('本次回复未完成')
  })

  it('falls back to the streamed text when the terminal event was empty', () => {
    const content = resolveAssistantTurnContent({
      completedContent: '',
      provisionalContent: '正在分析加购流程，第一条问题是',
      runError: 'provider 500',
    })

    expect(content.startsWith('正在分析加购流程')).toBe(true)
    expect(content).toContain('本次回复未完成')
  })

  it('echoes a Chinese diagnostic first line so the cause stays visible', () => {
    const content = resolveAssistantTurnContent({
      completedContent: '',
      runError: '模型在最终汇总阶段返回了未执行的工具协议文本（检测到 DSML 标记）\n堆栈略',
    })

    expect(content).toBe('本次回复未完成：模型在最终汇总阶段返回了未执行的工具协议文本（检测到 DSML 标记）')
  })

  it('keeps the text streamed before the user stopped the round', () => {
    const content = resolveAssistantTurnContent({
      completedContent: '',
      provisionalContent: '先说明三点：第一点是',
      userAborted: true,
    })

    expect(content.startsWith('先说明三点')).toBe(true)
    expect(content).toContain('已由用户停止')
    expect(content).not.toContain('本次回复未完成')
  })

  it('stores a stop marker when the user stopped before any text arrived', () => {
    const content = resolveAssistantTurnContent({
      completedContent: '',
      provisionalContent: '',
      userAborted: true,
    })

    expect(content).toBe('（本轮已由用户停止）')
  })

  it('keeps both the pre-tool sections and the trailing streamed text on a stop', () => {
    const content = resolveAssistantTurnContent({
      completedContent: '## 结论\n\n先看加购流程',
      provisionalContent: '然后第二条问题是幂等性',
      userAborted: true,
    })

    expect(content.startsWith('## 结论')).toBe(true)
    expect(content).toContain('然后第二条问题是幂等性')
    expect(content.endsWith('（本轮已由用户停止）')).toBe(true)
  })

  it('stores the reply once when a stop lands after the answer already finished', () => {
    const answer = '## 软件测试的基本流程\n\n一、需求分析\n\n二、测试计划'
    const content = resolveAssistantTurnContent({
      completedContent: answer,
      provisionalContent: answer,
      userAborted: true,
    })

    expect(content).toBe(`${answer}\n\n（本轮已由用户停止）`)
  })

  it('does not repeat streamed text the terminal content already contains', () => {
    const content = resolveAssistantTurnContent({
      completedContent: '## 结论\n\n先看加购流程\n\n然后第二条问题是幂等性',
      provisionalContent: '然后第二条问题是幂等性',
      userAborted: true,
    })

    expect(content.match(/然后第二条问题是幂等性/g)).toHaveLength(1)
    expect(content.endsWith('（本轮已由用户停止）')).toBe(true)
  })
})
