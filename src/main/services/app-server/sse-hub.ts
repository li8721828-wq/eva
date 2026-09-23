import { randomUUID } from 'crypto'
import type { ServerResponse } from 'http'
import type { ServerEvent } from './protocol'

export interface EventFilter {
  /** When set, only events with `conversationId === filter` are forwarded. */
  conversationId?: string
  topic?: ServerEvent['topic']
}

export type EventSink = (event: ServerEvent) => void

interface HubClient {
  filter: EventFilter
  deliver: EventSink
  close: () => void
}

/**
 * Fan-out for server-originated events. A subscriber is a callback plus a
 * filter, so the Server-Sent-Events response and the ACP WebSocket can share
 * one source of truth instead of each re-implementing matching. Each connected
 * entry is dropped when its transport closes.
 */
export class SseHub {
  private clients = new Map<string, HubClient>()
  private seqByTopic = new Map<ServerEvent['topic'], number>()

  /** Attach a plain callback sink. The returned function unsubscribes. */
  subscribe(sink: EventSink, filter: EventFilter = {}): () => void {
    const id = randomUUID()
    this.clients.set(id, { filter, deliver: sink, close: () => undefined })
    return () => {
      this.clients.delete(id)
    }
  }

  addClient(response: ServerResponse, filter: EventFilter = {}): string {
    const id = randomUUID()
    this.clients.set(id, {
      filter,
      deliver: (event) => response.write(this.frame(event)),
      close: () => { try { response.end() } catch { /* already gone */ } },
    })

    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders?.()
    response.write(`retry: 3000\n\n`)

    const heartbeat = setInterval(() => {
      try { response.write(': keepalive\n\n') } catch { /* ignore */ }
    }, 20_000)
    response.once('close', () => {
      clearInterval(heartbeat)
      this.clients.delete(id)
    })
    return id
  }

  clientCount(): number {
    return this.clients.size
  }

  broadcast(event: Omit<ServerEvent, 'seq'>): void {
    const seq = (this.seqByTopic.get(event.topic) ?? 0) + 1
    this.seqByTopic.set(event.topic, seq)
    const fullEvent: ServerEvent = { ...event, seq }
    for (const client of this.clients.values()) {
      if (!matches(client.filter, fullEvent)) continue
      try { client.deliver(fullEvent) } catch { /* connection closed */ }
    }
  }

  closeAll(): void {
    for (const client of this.clients.values()) client.close()
    this.clients.clear()
  }

  /** One Server-Sent Event frame; the only place SSE framing is spelled out. */
  private frame(event: ServerEvent): string {
    return [`event: ${event.type}`, `data: ${JSON.stringify(event)}`, '', ''].join('\n')
  }
}

function matches(filter: EventFilter, event: ServerEvent): boolean {
  if (filter.topic && filter.topic !== event.topic) return false
  if (filter.conversationId && filter.conversationId !== event.conversationId) return false
  return true
}
