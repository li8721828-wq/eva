import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dropQueuedItemsFor,
  enqueueStreamItem,
  flushRevealQueue,
  queuedTextFor,
  setRevealPacingCheck,
  setRevealSink,
} from '../../src/renderer/lib/stream-reveal-queue'
import type { ChatStreamEvent } from '../../src/shared/types'

describe('stream reveal queue', () => {
  let emitted: ChatStreamEvent[]

  beforeEach(() => {
    vi.useFakeTimers()
    emitted = []
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
    setRevealSink((event) => emitted.push(event))
    setRevealPacingCheck(() => true)
  })

  afterEach(() => {
    flushRevealQueue()
    setRevealPacingCheck(() => true)
    setRevealSink(() => {})
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const revealedText = (): string =>
    emitted.filter((event) => event.type === 'text_delta').map((event) => event.content || '').join('')

  it('reveals queued text one character per interval in order', () => {
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: '架构审查结论' })

    vi.advanceTimersByTime(1000)

    expect(revealedText()).toBe('架构审查结论')
    expect(emitted.every((event) => event.conversationId === 'conversation-a')).toBe(true)
  })

  it('holds the terminal event until every character ahead of it is revealed', () => {
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: 'ab' })
    enqueueStreamItem({ kind: 'terminal', event: { type: 'done', conversationId: 'conversation-a', content: '' } })

    vi.advanceTimersByTime(42)
    expect(emitted.filter((event) => event.type === 'done')).toHaveLength(0)

    vi.advanceTimersByTime(1000)
    expect(revealedText()).toBe('ab')
    expect(emitted.filter((event) => event.type === 'done')).toHaveLength(1)
  })

  it('never leaks a previous round into the conversation that starts a new one', () => {
    const previousRound = '上一轮还没显示完的回复'
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: previousRound })
    enqueueStreamItem({ kind: 'terminal', event: { type: 'done', conversationId: 'conversation-a', content: '' } })

    vi.advanceTimersByTime(126)
    const revealedBeforeDrop = revealedText()
    expect(revealedBeforeDrop.length).toBeGreaterThan(0)
    expect(revealedBeforeDrop.length).toBeLessThan(previousRound.length)

    dropQueuedItemsFor('conversation-a')
    vi.advanceTimersByTime(10_000)

    expect(revealedText()).toBe(revealedBeforeDrop)
    expect(emitted.filter((event) => event.type === 'done')).toHaveLength(0)
    expect(queuedTextFor('conversation-a')).toBe('')
  })

  it('drops only the conversation that was reset', () => {
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: 'aa' })
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-b', content: 'bb' })

    dropQueuedItemsFor('conversation-a')
    vi.advanceTimersByTime(10_000)

    expect(revealedText()).toBe('bb')
    expect(emitted.every((event) => event.conversationId === 'conversation-b')).toBe(true)
  })

  it('does not hold one conversation behind another conversation\'s character pacing', () => {
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: '一二三四五六七八九十' })
    enqueueStreamItem({ kind: 'terminal', event: { type: 'done', conversationId: 'conversation-b', content: '' } })

    vi.advanceTimersByTime(300)

    // B only waits out the ink-settle window; A's ten characters need ~420ms.
    expect(emitted.filter((event) => event.type === 'done')).toHaveLength(1)
    expect(revealedText().length).toBeGreaterThan(0)
    expect(revealedText().length).toBeLessThan(10)
  })

  it('catches up on a long delta instead of spending one interval per character', () => {
    const long = '字'.repeat(600)
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: long })

    // 27 ticks in: one character per interval would have revealed 27 characters.
    vi.advanceTimersByTime(1_100)
    expect(Array.from(revealedText()).length).toBeGreaterThan(400)

    // The rest keeps draining, so the backlog clears in seconds instead of the
    // 25 seconds a fixed per-character interval needed.
    vi.advanceTimersByTime(3_000)
    expect(revealedText()).toBe(long)
    expect(queuedTextFor('conversation-a')).toBe('')
  })

  it('never releases more than one capped chunk per tick', () => {
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: '回'.repeat(2000) })

    vi.advanceTimersByTime(42)

    const deltas = emitted.filter((event) => event.type === 'text_delta')
    expect(deltas.length).toBeGreaterThan(1)
    expect(Math.max(...deltas.map((event) => Array.from(event.content || '').length))).toBeLessThanOrEqual(24)
  })

  it('settles a terminal event behind a long reply in seconds, not minutes', () => {
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: '回'.repeat(2000) })
    enqueueStreamItem({ kind: 'terminal', event: { type: 'done', conversationId: 'conversation-a', content: '' } })

    // Draining 2000 characters plus the ink-settle window takes ~6.5 seconds; a
    // fixed per-character interval took 84 seconds before `done` could fire.
    vi.advanceTimersByTime(7_000)

    expect(emitted.filter((event) => event.type === 'done')).toHaveLength(1)
    expect(revealedText()).toHaveLength(2000)
  })

  it('never splits a surrogate pair across two reveals', () => {
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: '👋好的' })

    vi.advanceTimersByTime(1000)

    expect(revealedText()).toBe('👋好的')
    expect(revealedText()).not.toContain('\uFFFD')
  })

  it('releases text in one delta when the conversation is not pacing reveals', () => {
    setRevealPacingCheck(() => false)
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: '工具轮之后的最终答案' })

    vi.advanceTimersByTime(5)

    expect(revealedText()).toBe('工具轮之后的最终答案')
    expect(emitted.filter((event) => event.type === 'text_delta')).toHaveLength(1)
  })

  it('stops pacing mid-item without reordering the remaining characters', () => {
    let pacing = true
    setRevealPacingCheck(() => pacing)
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: 'abcd' })

    vi.advanceTimersByTime(84)
    expect(revealedText()).toBe('abc')

    pacing = false
    vi.advanceTimersByTime(42)
    expect(revealedText()).toBe('abcd')
  })

  it('reports and flushes whatever is still queued', () => {
    enqueueStreamItem({ kind: 'text', conversationId: 'conversation-a', content: '两段' })
    enqueueStreamItem({ kind: 'event', event: { type: 'thinking', conversationId: 'conversation-a', content: '还在继续' } })

    expect(queuedTextFor('conversation-a')).toBe('两段')

    flushRevealQueue()

    expect(revealedText()).toBe('两段')
    expect(emitted.some((event) => event.type === 'thinking')).toBe(true)
    expect(queuedTextFor('conversation-a')).toBe('')
  })
})
