import type { ChatStreamEvent } from '../../shared/types'

/**
 * Character-paced reveal queue for streamed chat text.
 *
 * The queue lives outside React and outside the chat store on purpose: a round
 * that finishes while its text is still being revealed must be droppable
 * before the next round starts, otherwise the leftovers replay inside the new
 * reply. The store imports `dropQueuedItemsFor`, and the sink is registered by
 * the streaming hook, so this module never imports the store back.
 *
 * Queues are kept per conversation. A single shared FIFO serialized unrelated
 * conversations behind whichever one was revealing text, so a long reply in one
 * conversation held back another conversation's tool events and `done` by its
 * own character pacing.
 */
export type QueuedStreamItem =
  | { kind: 'text'; conversationId: string; content: string }
  | { kind: 'event'; event: ChatStreamEvent }
  | { kind: 'terminal'; event: ChatStreamEvent }

// Keep the provider request genuinely streaming, but release text to the
// renderer on a fixed tick. A constant per-character interval made a long reply
// take one character * 42ms to drain (2000 characters ≈ 84 seconds) and held
// `done` behind all of it. Instead each tick releases a fraction of the backlog,
// so a short reply keeps the human typing cadence while a long one self-corrects
// into seconds. The cap keeps a big delta from appearing as one visual jump.
const REVEAL_TICK_MS = 42
const CATCH_UP_DIVISOR = 24
const MAX_CHARACTERS_PER_TICK = 24
const FINAL_INK_SETTLE_MS = 230

/** Events the main process did not attribute to a conversation share one queue. */
const UNOWNED_KEY = ''

type RevealSink = (event: ChatStreamEvent) => void

interface RevealQueue {
  items: QueuedStreamItem[]
  timer: number | null
}

let sink: RevealSink | null = null
const queues = new Map<string, RevealQueue>()

/**
 * Whether text for a conversation should still be revealed character by
 * character. Pacing only exists to make visible text appear gradually; text the
 * UI is not rendering yet (a tool round's unfinished synthesis) would just
 * delay the terminal event behind tens of seconds of invisible animation. The
 * check is consulted on every step so the switch takes effect mid-item without
 * reordering anything.
 */
let shouldPaceReveal: (conversationId: string) => boolean = () => true

export function setRevealSink(next: RevealSink): void {
  sink = next
}

export function setRevealPacingCheck(check: (conversationId: string) => boolean): void {
  shouldPaceReveal = check
}

function ownerOf(item: QueuedStreamItem): string {
  return item.kind === 'text' ? item.conversationId : item.event.conversationId || UNOWNED_KEY
}

function queueFor(key: string): RevealQueue {
  const existing = queues.get(key)
  if (existing) return existing
  const created: RevealQueue = { items: [], timer: null }
  queues.set(key, created)
  return created
}

function clearFlushTimer(queue: RevealQueue): void {
  if (queue.timer !== null) {
    window.clearTimeout(queue.timer)
    queue.timer = null
  }
}

function emit(event: ChatStreamEvent): void {
  sink?.(event)
}

/** Characters still waiting to be revealed anywhere in one conversation's queue. */
function pendingCharacterCount(queue: RevealQueue): number {
  let total = 0
  for (const queued of queue.items) {
    if (queued.kind === 'text') total += Array.from(queued.content).length
  }
  return total
}

function charactersPerTick(pendingCharacters: number): number {
  return Math.min(MAX_CHARACTERS_PER_TICK, Math.max(1, Math.ceil(pendingCharacters / CATCH_UP_DIVISOR)))
}

function drainQueue(key: string): void {
  const queue = queues.get(key)
  if (!queue) return
  queue.timer = null
  const item = queue.items[0]
  if (!item) return

  if (item.kind === 'text') {
    // Slice by code point: a surrogate pair split across two deltas would
    // otherwise render as replacement characters.
    const characters = Array.from(item.content)
    if (characters.length === 0) {
      queue.items.shift()
      queue.timer = window.setTimeout(() => drainQueue(key), 0)
      return
    }
    if (!shouldPaceReveal(item.conversationId)) {
      // Hidden text is released in one delta. Order is still preserved: the
      // item keeps its position, and the store appends deltas in arrival order.
      emit({ type: 'text_delta', conversationId: item.conversationId, content: item.content })
      queue.items.shift()
      queue.timer = window.setTimeout(() => drainQueue(key), 0)
      return
    }
    const take = characters.slice(0, charactersPerTick(pendingCharacterCount(queue))).join('')
    item.content = item.content.slice(take.length)
    emit({ type: 'text_delta', conversationId: item.conversationId, content: take })
    if (!item.content) queue.items.shift()
    queue.timer = window.setTimeout(() => drainQueue(key), REVEAL_TICK_MS)
    return
  }

  queue.items.shift()
  if (item.kind === 'terminal') {
    // Let the last characters settle before the reply is finalized, so a
    // terminal event never truncates ink that is still animating in.
    queue.timer = window.setTimeout(() => {
      queue.timer = null
      emit(item.event)
      drainQueue(key)
    }, FINAL_INK_SETTLE_MS)
    return
  }

  emit(item.event)
  queue.timer = window.setTimeout(() => drainQueue(key), 0)
}

function scheduleQueueDrain(key: string): void {
  const queue = queues.get(key)
  if (!queue || queue.timer !== null || queue.items.length === 0) return
  queue.timer = window.setTimeout(() => drainQueue(key), 0)
}

export function enqueueStreamItem(item: QueuedStreamItem): void {
  const key = ownerOf(item)
  queueFor(key).items.push(item)
  scheduleQueueDrain(key)
}

/** Text still waiting to be revealed for one conversation. */
export function queuedTextFor(conversationId: string): string {
  return (queues.get(conversationId)?.items || [])
    .filter((item): item is Extract<QueuedStreamItem, { kind: 'text' }> => item.kind === 'text')
    .map((item) => item.content)
    .join('')
}

/**
 * Drop everything still queued for one conversation. Called when a round ends
 * by other means (abort, clear) or when a new round starts, so a stale reveal
 * or terminal event can never land inside the next reply.
 */
export function dropQueuedItemsFor(conversationId: string): void {
  const queue = queues.get(conversationId)
  if (!queue) return
  clearFlushTimer(queue)
  queues.delete(conversationId)
}

/** Apply every queued item immediately, used when the listener unmounts. */
export function flushRevealQueue(): void {
  for (const queue of queues.values()) clearFlushTimer(queue)
  for (const queue of queues.values()) {
    for (const item of queue.items) {
      if (item.kind === 'text') {
        emit({ type: 'text_delta', conversationId: item.conversationId, content: item.content })
      } else {
        emit(item.event)
      }
    }
    queue.items.length = 0
  }
  queues.clear()
}
