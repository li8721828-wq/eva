import { describe, expect, it } from 'vitest'
import http from 'http'
import { SseHub } from '../../src/main/services/app-server/sse-hub'

/**
 * Minimal mock of `ServerResponse` that captures writes to an in-memory buffer.
 */
function makeMockResponse(): { res: any; written: string } {
  const store = { value: '' }
  const res: any = {
    setHeader: () => undefined,
    write(chunk: string): boolean { store.value += chunk; return true },
    end() { /* noop */ },
    once(_evt: string, _cb: () => void) { return this },
    flushHeaders: () => undefined,
  }
  return {
    res,
    get written(): string { return store.value },
  }
}

describe('SseHub', () => {
  it('sends an initial retry frame and broadcasts to all matching clients', () => {
    const hub = new SseHub()
    const a = makeMockResponse()
    const b = makeMockResponse()
    hub.addClient(a.res as never, {})
    hub.addClient(b.res as never, { topic: 'turn' })
    expect(a.written).toContain('retry: 3000')
    expect(b.written).toContain('retry: 3000')

    hub.broadcast({ topic: 'turn', type: 'turn/text_delta', data: { content: 'hi' }, ts: 1, conversationId: 't1' })
    expect(a.written).toContain('event: turn/text_delta')
    expect(a.written).toContain('"content":"hi"')
    expect(b.written).toContain('event: turn/text_delta')
  })

  it('respects the conversationId filter', () => {
    const hub = new SseHub()
    const a = makeMockResponse()
    const b = makeMockResponse()
    hub.addClient(a.res as never, { conversationId: 't1' })
    hub.addClient(b.res as never, { conversationId: 't2' })
    hub.broadcast({ topic: 'turn', type: 'turn/text_delta', data: { content: 'one' }, ts: 2, conversationId: 't1' })
    expect(a.written).toContain('"content":"one"')
    expect(b.written).not.toContain('"content":"one"')
  })

  it('monotonically increments sequence per topic', () => {
    const hub = new SseHub()
    const a = makeMockResponse()
    hub.addClient(a.res as never, {})
    const before = a.written.length
    hub.broadcast({ topic: 'turn', type: 'turn/started', data: {}, ts: 3 })
    hub.broadcast({ topic: 'turn', type: 'turn/text_delta', data: {}, ts: 4 })
    const after = a.written.slice(before)
    const seqs = [...after.matchAll(/"seq":(\d+)/g)].map((m) => Number(m[1]))
    expect(seqs.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }
  })
})

/** Tiny up/down smoke test for the loopback HTTP server pipeline. */
describe('HTTP transport', () => {
  it('opens a loopback port via createServer', async () => {
    const server = http.createServer((_req, res) => { res.end('pong') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as any).port as number
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      })
      req.on('error', reject)
      req.end()
    })
    expect(body).toBe('pong')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
