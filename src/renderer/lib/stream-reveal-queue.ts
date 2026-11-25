import type { ChatStreamEvent } from '../../shared/types'
import { CHAT_TEXT_FADE_MS } from './stream-presentation'

/** Ordered, conversation-local transport buffer. Text animation belongs to
 * the Markdown renderer; buffering must never add a second typewriter clock. */
export type QueuedStreamItem =
  | { kind: 'text'; conversationId: string; content: string }
  | { kind: 'event'; event: ChatStreamEvent }
  | { kind: 'terminal'; event: ChatStreamEvent }

const FRAME_MS = 16
const UNOWNED_KEY = ''
interface RevealQueue {
  items: QueuedStreamItem[]
  timer: number | null
}

let sink: ((event: ChatStreamEvent) => void) | null = null
let isTextVisible: (conversationId: string) => boolean = () => true
const queues = new Map<string, RevealQueue>()

export function setRevealSink(next: (event: ChatStreamEvent) => void): void {
  sink = next
}

/** Invisible/duplicate replies do not need an animation-settle window. */
export function setRevealVisibilityCheck(check: (conversationId: string) => boolean): void {
  isTextVisible = check
}

function ownerOf(item: QueuedStreamItem): string {
  return item.kind === 'text' ? item.conversationId : item.event.conversationId || UNOWNED_KEY
}

function clearFlushTimer(queue: RevealQueue): void {
  if (queue.timer !== null) window.clearTimeout(queue.timer)
  queue.timer = null
}

function emit(item: QueuedStreamItem): void {
  sink?.(item.kind === 'text'
    ? { type: 'text_delta', conversationId: item.conversationId, content: item.content }
    : item.event)
}

function drainQueue(key: string): void {
  const queue = queues.get(key)
  if (!queue) return
  queue.timer = null
  while (queue.items.length && queues.get(key) === queue) {
    const item = queue.items[0]
    if (item.kind === 'terminal' && isTextVisible(key)) {
      // All received text is already committed. Only let its last fade finish;
      // the wait is constant, independent of answer length or packet count.
      queue.timer = window.setTimeout(() => {
        queue.timer = null
        queue.items.shift()
        emit(item)
        if (queues.get(key) === queue) drainQueue(key)
      }, CHAT_TEXT_FADE_MS)
      return
    }
    queue.items.shift()
    emit(item)
  }
  if (queues.get(key) === queue) queues.delete(key)
}

export function enqueueStreamItem(item: QueuedStreamItem): void {
  const key = ownerOf(item)
  let queue = queues.get(key)
  if (!queue) {
    queue = { items: [], timer: null }
    queues.set(key, queue)
  }
  const previous = queue.items.at(-1)
  // Adjacent small provider packets become one render update. Never merge
  // across text_reset, tools or native SDK events: those boundaries are real.
  if (item.kind === 'text' && previous?.kind === 'text') previous.content += item.content
  else queue.items.push(item)

  if (item.kind === 'event' && (item.event.type === 'ask_user_request' || item.event.type === 'ask_user_closed')) {
    flushQueue(key)
    return
  }
  if (queue.timer === null) queue.timer = window.setTimeout(() => drainQueue(key), FRAME_MS)
}

export function queuedTextFor(conversationId: string): string {
  return (queues.get(conversationId)?.items || [])
    .filter((item): item is Extract<QueuedStreamItem, { kind: 'text' }> => item.kind === 'text')
    .map(item => item.content).join('')
}

/** Abort/new-round cleanup must also cancel a pending terminal event. */
export function dropQueuedItemsFor(conversationId: string): void {
  const queue = queues.get(conversationId)
  if (!queue) return
  clearFlushTimer(queue)
  queues.delete(conversationId)
}

function flushQueue(key: string): void {
  const queue = queues.get(key)
  if (!queue) return
  clearFlushTimer(queue)
  queues.delete(key)
  for (const item of queue.items) emit(item)
}

export function flushRevealQueue(): void {
  for (const key of [...queues.keys()]) flushQueue(key)
}
