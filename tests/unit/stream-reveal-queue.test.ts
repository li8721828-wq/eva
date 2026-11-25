import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dropQueuedItemsFor, enqueueStreamItem, flushRevealQueue, queuedTextFor,
  setRevealVisibilityCheck, setRevealSink,
} from '../../src/renderer/lib/stream-reveal-queue'
import { CHAT_TEXT_FADE_MS } from '../../src/renderer/lib/stream-presentation'
import type { ChatStreamEvent } from '../../src/shared/types'

describe('stream presentation buffer', () => {
  let emitted: ChatStreamEvent[]
  beforeEach(() => {
    vi.useFakeTimers()
    emitted = []
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
    setRevealSink(event => emitted.push(event))
    setRevealVisibilityCheck(() => true)
  })
  afterEach(() => {
    flushRevealQueue()
    setRevealVisibilityCheck(() => true)
    setRevealSink(() => {})
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  const text = (content: string, conversationId = 'a') =>
    enqueueStreamItem({ kind: 'text', conversationId, content })
  const event = (type: ChatStreamEvent['type'], conversationId = 'a') =>
    enqueueStreamItem({ kind: 'event', event: { type, conversationId } })
  const done = (conversationId = 'a') =>
    enqueueStreamItem({ kind: 'terminal', event: { type: 'done', conversationId } })
  const revealed = () => emitted.filter(e => e.type === 'text_delta').map(e => e.content).join('')

  it('coalesces adjacent packets into the next frame without another typewriter', () => {
    for (const character of '你好，世界👋') text(character)
    expect(emitted).toHaveLength(0)
    vi.advanceTimersByTime(16)
    expect(revealed()).toBe('你好，世界👋')
    expect(emitted).toHaveLength(1)
    expect(queuedTextFor('a')).toBe('')
  })

  it.each([1, 2000, 100000])('commits %i characters and completes in a constant settle window', length => {
    const content = '字'.repeat(length)
    for (let i = 0; i < content.length; i += 5) text(content.slice(i, i + 5))
    done()
    vi.advanceTimersByTime(16)
    expect(revealed()).toBe(content)
    expect(emitted.map(e => e.type)).toEqual(['text_delta'])
    vi.advanceTimersByTime(CHAT_TEXT_FADE_MS)
    expect(emitted.map(e => e.type)).toEqual(['text_delta', 'done'])
  })

  it('preserves text/reset/tool/error order instead of coalescing across boundaries', () => {
    text('工具前')
    event('text_reset')
    event('tool_call')
    text('工具后')
    event('error')
    vi.advanceTimersByTime(16)
    expect(emitted.map(e => e.type)).toEqual(['text_delta', 'text_reset', 'tool_call', 'text_delta', 'error'])
    expect(revealed()).toBe('工具前工具后')
  })

  it('preserves native SDK event identities and order', () => {
    const native = ['message_start', 'text_delta', 'tool_start'].map((type, sequence) => ({
      type: 'native_event', conversationId: 'a',
      nativeEvent: { type, sequence, engine: 'pi', runId: 'one', timestamp: sequence, content: type === 'text_delta' ? '原生文字' : undefined },
    } as ChatStreamEvent))
    native.forEach(event => enqueueStreamItem({ kind: 'event', event }))
    vi.advanceTimersByTime(16)
    expect(emitted).toEqual(native)
    expect(emitted[1]).toBe(native[1])
  })

  it('does not hold a foreground conversation behind background text', () => {
    text('字'.repeat(20000), 'background')
    text('前台', 'foreground')
    done('foreground')
    vi.advanceTimersByTime(16 + CHAT_TEXT_FADE_MS)
    expect(emitted.filter(e => e.conversationId === 'foreground').map(e => e.type)).toEqual(['text_delta', 'done'])
  })

  it('skips the settle window for text that is not rendered', () => {
    setRevealVisibilityCheck(() => false)
    text('已在持久化消息中显示')
    done()
    vi.advanceTimersByTime(16)
    expect(emitted.map(e => e.type)).toEqual(['text_delta', 'done'])
  })

  it('does not replay queued text or a terminal event into a new round', () => {
    text('旧轮次')
    done()
    dropQueuedItemsFor('a')
    text('新轮次')
    vi.runAllTimers()
    expect(revealed()).toBe('新轮次')
    expect(emitted.map(e => e.type)).toEqual(['text_delta'])
  })

  it('cancels a terminal timer that has already started without affecting another chat', () => {
    text('已显示')
    done()
    vi.advanceTimersByTime(16)
    dropQueuedItemsFor('a')
    text('另一个会话', 'b')
    done('b')
    vi.runAllTimers()
    expect(emitted.filter(e => e.type === 'done').map(e => e.conversationId)).toEqual(['b'])
  })

  it.each(['ask_user_request', 'ask_user_closed'] as const)('commits preceding items immediately for %s in its own chat', type => {
    text('后台', 'b')
    text('问题前')
    done()
    vi.advanceTimersByTime(16)
    text('补充')
    event(type)
    expect(emitted.filter(e => e.conversationId === 'a').map(e => e.type)).toEqual(['text_delta', 'done', 'text_delta', type])
    vi.runAllTimers()
    expect(emitted.filter(e => e.type === 'done')).toHaveLength(1)
  })

  it('flushes and cancels all pending timers on unmount', () => {
    text('两段')
    event('thinking')
    done()
    expect(queuedTextFor('a')).toBe('两段')
    flushRevealQueue()
    vi.runAllTimers()
    expect(emitted.map(e => e.type)).toEqual(['text_delta', 'thinking', 'done'])
    expect(queuedTextFor('a')).toBe('')
  })

  it('allows the sink to drop the old round while consuming an event', () => {
    setRevealSink(e => { emitted.push(e); if (e.type === 'text_reset') dropQueuedItemsFor('a') })
    event('text_reset')
    text('不得进入新轮次')
    vi.runAllTimers()
    expect(emitted.map(e => e.type)).toEqual(['text_reset'])
  })
})
