import { randomUUID } from 'crypto'
import type { ServerResponse } from 'http'
import type { ServerEvent } from './protocol'

interface SseClient {
  id: string
  /** Filter: when set, only events with `conversationId === filter` are forwarded. */
  conversationId?: string
  topic?: ServerEvent['topic']
  response: ServerResponse
}

/**
 * Bounded fan-out for Server-Sent Events. Each connected HTTP client gets a
 * dedicated entry; broadcast() sends an event to every client whose filter
 * matches. Clients are GC'd when their response closes.
 */
export class SseHub {
  private clients = new Map<string, SseClient>()
  private seqByTopic = new Map<ServerEvent['topic'], number>()

  addClient(response: ServerResponse, filter: { conversationId?: string; topic?: ServerEvent['topic'] } = {}): string {
    const id = randomUUID()
    this.clients.set(id, { id, response, ...filter })

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
    const payload = JSON.stringify(fullEvent)
    const lines = [`event: ${fullEvent.type}`, `data: ${payload}`, '', '']
    const frame = lines.join('\n')
    for (const client of this.clients.values()) {
      if (client.topic && client.topic !== event.topic) continue
      if (client.conversationId && client.conversationId !== event.conversationId) continue
      try { client.response.write(frame) } catch { /* connection closed */ }
    }
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      try { client.response.end() } catch { /* ignore */ }
    }
    this.clients.clear()
  }
}
