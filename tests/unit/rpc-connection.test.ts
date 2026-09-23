import { describe, expect, it } from 'vitest'
import { RPC_ERROR_CODE } from '../../src/main/services/app-server/protocol'
import { RpcConnection, RpcError } from '../../src/main/services/app-server/rpc-connection'

/**
 * Contract tests for the transport-agnostic JSON-RPC connection that the ACP
 * WebSocket door is built on. Every assertion is made on the *captured frame
 * strings*, because that is all a client sees: the guarantees that matter are
 * "one write = one complete object", "responses and notifications share one
 * ordered stream", and "the two id spaces never bleed into each other".
 *
 * `parseFrame()` is the load-bearing helper: it re-serializes what it parsed and
 * demands the bytes match, so a message written in two pieces — or two messages
 * smuggled into one write — fails the whole suite rather than passing on `toContain`.
 */

interface Frame {
  jsonrpc?: string
  id?: unknown
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface Harness {
  conn: RpcConnection
  /** One entry per `write()` call, in the order the transport was handed it. */
  frames: string[]
  /** Reasons passed to `onClosed`. */
  closes: string[]
  /** Every captured frame, parsed and framing-checked. */
  messages(): Frame[]
}

function harness(options: { failFrom?: number } = {}): Harness {
  const frames: string[] = []
  const closes: string[] = []
  const conn = new RpcConnection({
    write: (frame: string) => {
      frames.push(frame)
      // Mimic a socket that died: every write from here on throws, as `ws.send`
      // does once the readyState is no longer OPEN.
      if (options.failFrom !== undefined && frames.length >= options.failFrom) {
        throw new Error('EPIPE: the transport is gone')
      }
    },
    onClosed: (reason: string) => {
      closes.push(reason)
    },
  })
  return {
    conn,
    frames,
    closes,
    messages(): Frame[] {
      return frames.map((frame) => parseFrame(frame))
    },
  }
}

function parseFrame(frame: string): Frame {
  expect(frame).toBeTypeOf('string')
  const parsed = JSON.parse(frame) as Frame
  expect(parsed).toBeTypeOf('object')
  expect(Array.isArray(parsed)).toBe(false)
  // One object per frame: nothing split off the end, nothing appended after it.
  expect(JSON.stringify(parsed)).toBe(frame)
  expect(parsed.jsonrpc).toBe('2.0')
  return parsed
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drain every pending microtask, i.e. every handler continuation the connection queued. */
async function settled(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

const REQUEST = { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 'c1' } }

describe('RpcConnection outbound stream', () => {
  it('keeps one ordered stream: a notification raised while a request is in flight is written first', async () => {
    const h = harness()
    const gate = deferred<void>()
    h.conn.on('session/prompt', async (params) => {
      await gate.promise
      return { stopReason: 'end_turn', saw: params }
    })

    h.conn.receive(JSON.stringify(REQUEST))
    expect(h.frames).toEqual([]) // the answer is still owed

    h.conn.notify('session/update', { sessionId: 'c1', update: { sessionUpdate: 'agent_message_chunk' } })
    expect(h.frames).toHaveLength(1)

    gate.resolve()
    await settled()

    const frames = h.messages()
    expect(frames).toHaveLength(2)
    // Notification first, and it is a notification: no id, so nothing waits on it.
    expect(frames[0].method).toBe('session/update')
    expect(frames[0].id).toBeUndefined()
    expect(frames[0].params).toEqual({ sessionId: 'c1', update: { sessionUpdate: 'agent_message_chunk' } })
    // Response second, on the same stream, and it answers the original request.
    expect(frames[1]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { stopReason: 'end_turn', saw: { sessionId: 'c1' } },
    })
  })

  it('writes exactly one complete JSON-RPC object per write, for every kind of message', async () => {
    const h = harness()
    h.conn.on('echo', (params) => params)

    const big = { text: 'x'.repeat(5000), nested: { deep: [1, 2, { u: 'a\nb"c\\' }] } }
    h.conn.notify('session/update', big)
    expect(h.frames).toHaveLength(1) // one logical message, one write

    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: 'echo', params: { a: 1 } }))
    await settled() // let the answer leave before the next message is raised

    const outstanding = h.conn.request('session/request_permission', { sessionId: 'c1', options: [1, 2, 3] })
    await settled()

    const frames = h.messages()
    expect(frames).toHaveLength(3)
    expect((frames[0].params as { text: string }).text).toHaveLength(5000)
    // Multi-line and quote-bearing payloads stay inside one object, not split on newlines.
    expect(h.frames[0]).not.toContain('\n')
    expect(frames[1]).toEqual({ jsonrpc: '2.0', id: 'r1', result: { a: 1 } })
    expect(frames[2]).toEqual({
      jsonrpc: '2.0',
      id: 'eva:1',
      method: 'session/request_permission',
      params: { sessionId: 'c1', options: [1, 2, 3] },
    })

    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'eva:1', result: 'ok' }))
    await expect(outstanding).resolves.toBe('ok')
  })

  it('omits the params key rather than writing null for a parameterless message', () => {
    const h = harness()
    h.conn.notify('session/cancel')
    h.conn.request('agent/ask')
    const frames = h.messages()
    expect(Object.keys(frames[0])).toEqual(['jsonrpc', 'method'])
    expect(Object.keys(frames[1])).toEqual(['jsonrpc', 'id', 'method'])
  })
})

describe('RpcConnection inbound ids', () => {
  it('echoes the caller id verbatim, including one wearing the outbound prefix', async () => {
    const h = harness()
    h.conn.on('ping', () => 'pong')

    const inbound: Array<number | string> = [42, 0, 'call-7', 'eva:1', 'eva:999', ' padded ']
    for (const id of inbound) h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }))
    await settled()

    const frames = h.messages()
    expect(frames.map((frame) => frame.id)).toEqual(inbound)
    expect(frames.map((frame) => frame.result)).toEqual(inbound.map(() => 'pong'))
    // Not renumbered, not stringified, not offset by this connection's own counter.
    expect(typeof frames[0].id).toBe('number')
    expect(frames[3].id).toBe('eva:1')
    expect(h.conn.isClosed).toBe(false)
  })

  it('hands the handler the same id it will answer with', async () => {
    const h = harness()
    const seen: Array<unknown> = []
    h.conn.on('who', (_params, id) => {
      seen.push(id)
      return id
    })
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'eva:2', method: 'who' }))
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', method: 'who' })) // notification: no id
    await settled()
    expect(seen).toEqual(['eva:2', undefined])
    expect(h.messages().map((frame) => frame.id)).toEqual(['eva:2'])
  })
})

describe('RpcConnection outbound ids and pending requests', () => {
  it('issues its own prefixed request ids, unique per request', () => {
    const h = harness()
    h.conn.request('session/request_permission', { n: 1 })
    h.conn.request('session/request_permission', { n: 2 })
    h.conn.request('session/request_permission', { n: 3 })
    const ids = h.messages().map((frame) => frame.id)
    expect(ids).toEqual(['eva:1', 'eva:2', 'eva:3'])
    expect(new Set(ids).size).toBe(3)
    expect(ids.every((id) => typeof id === 'string' && id.startsWith('eva:'))).toBe(true)
  })

  it('settles only ids it issued itself and ignores other reply frames', async () => {
    const h = harness()
    const first = h.conn.request('agent/ask', { n: 1 })
    const second = h.conn.request('agent/ask', { n: 2 })
    const before = h.frames.length

    // Never issued by this side: an unknown outbound-looking id, an inbound-looking
    // numeric id, and a reply with no id at all. None of them may be answered.
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'eva:9', result: 'not mine' }))
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 99, result: 'not mine' }))
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', result: 'no id' }))
    expect(h.frames).toHaveLength(before)

    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'eva:1', result: { outcome: 'allow_once' } }))
    await expect(first).resolves.toEqual({ outcome: 'allow_once' })

    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'eva:2', error: { code: RPC_ERROR_CODE.UNAUTHORIZED, message: 'token rejected' } }))
    const failure = await second.catch((e: Error) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain(String(RPC_ERROR_CODE.UNAUTHORIZED))
    expect(failure.message).toContain('token rejected')
    expect(h.frames).toHaveLength(before) // settling is not a write
  })

  it('rejects a pending request when the reply carries a malformed error instead of settling it', async () => {
    const h = harness()
    const pending = h.conn.request<{ outcome: string }>('session/request_permission', { n: 1 }) // id eva:1

    // A client that answers with `error: "oops"` next to a usable-looking result.
    // Treating only object errors as failure would resolve this request with the
    // result and hand the run a permission nobody granted.
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'eva:1', error: 'oops', result: { outcome: 'allow_always' } }))

    const failure = await pending.catch((e: Error) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('oops')
  })

  it('does not let an inbound request wearing an outbound id settle the pending request', async () => {
    const h = harness()
    const pending = h.conn.request('agent/ask', { n: 1 }) // id eva:1

    // The client uses the same string as its own request id. No handler is registered,
    // so this must come back as METHOD_NOT_FOUND — and must leave `pending` alone.
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'eva:1', method: 'agent/ask' }))
    await settled()
    expect(h.messages().at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 'eva:1',
      error: { code: RPC_ERROR_CODE.METHOD_NOT_FOUND, message: expect.any(String) },
    })

    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'eva:1', result: { answered: true } }))
    await expect(pending).resolves.toEqual({ answered: true })
  })
})

describe('RpcConnection frame errors', () => {
  it('answers malformed JSON with PARSE_ERROR and a null id, without throwing', () => {
    const h = harness()
    expect(() => {
      h.conn.receive('{"jsonrpc":"2.0","id":1,"method":"x"') // truncated: the classic half frame
      h.conn.receive('not json at all')
      h.conn.receive('')
    }).not.toThrow()

    const frames = h.messages()
    expect(frames).toHaveLength(3)
    for (const frame of frames) {
      expect(frame.id).toBeNull()
      expect(frame.error?.code).toBe(RPC_ERROR_CODE.PARSE_ERROR)
      expect(frame.error?.message).toContain('Parse error')
      expect(frame.method).toBeUndefined()
    }
  })

  it('answers a non-2.0 envelope with INVALID_REQUEST and a null id', () => {
    const h = harness()
    h.conn.receive(JSON.stringify({ jsonrpc: '1.0', id: 3, method: 'x' }))
    h.conn.receive(JSON.stringify({ id: 3, method: 'x' }))
    h.conn.receive(JSON.stringify([{ jsonrpc: '2.0', id: 4, method: 'x' }])) // a batch is not one object
    h.conn.receive('null')
    h.conn.receive('"a string"')

    const frames = h.messages()
    expect(frames).toHaveLength(5)
    expect(frames.map((frame) => frame.error?.code)).toEqual(frames.map(() => RPC_ERROR_CODE.INVALID_REQUEST))
    expect(frames.every((frame) => frame.id === null)).toBe(true)
  })

  it('answers an unknown request with METHOD_NOT_FOUND but stays silent on an unknown notification', async () => {
    const h = harness()
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'm1', method: 'no/such' }))
    await settled()
    const frames = h.messages()
    expect(frames).toHaveLength(1)
    expect(frames[0].id).toBe('m1')
    expect(frames[0].error?.code).toBe(RPC_ERROR_CODE.METHOD_NOT_FOUND)
    expect(frames[0].error?.message).toContain('no/such')

    const before = h.frames.length
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', method: 'no/such' }))
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', method: 'no/such', params: { a: 1 } }))
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'no/such' }))
    await settled()
    expect(h.frames).toHaveLength(before) // nobody is waiting on a notification
  })

  it('still serves a well-formed frame after a run of broken ones', async () => {
    const h = harness()
    h.conn.on('ping', () => 'pong')
    h.conn.receive('{')
    h.conn.receive('{"jsonrpc":"1.1","id":1}')
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'ok', method: 'ping' }))
    await settled()
    const frames = h.messages()
    expect(frames.at(-1)).toEqual({ jsonrpc: '2.0', id: 'ok', result: 'pong' })
    expect(h.conn.isClosed).toBe(false)
  })
})

describe('RpcConnection close', () => {
  it('rejects outstanding requests, goes inert, and reports the reason exactly once', async () => {
    const h = harness()
    const gate = deferred<void>()
    h.conn.on('slow', async (params) => {
      await gate.promise
      return params
    })

    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'slow', params: { p: 1 } }))
    const outstanding = h.conn.request('agent/ask', { q: 1 })
    const before = h.frames.length

    h.conn.close('socket closed')

    await expect(outstanding).rejects.toThrow(/socket closed/)
    expect(h.conn.isClosed).toBe(true)
    expect(h.closes).toEqual(['socket closed'])

    // Inert from here on: nothing else may reach the transport.
    h.conn.notify('session/update', { x: 1 })
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'slow' }))
    h.conn.receive('garbage that would otherwise get a parse error')
    const afterClose = h.conn.request('agent/ask', { q: 2 })
    await expect(afterClose).rejects.toThrow(/agent\/ask/)

    gate.resolve() // the in-flight handler finally answers — into a closed connection
    await settled()
    expect(h.frames).toHaveLength(before)
    expect(h.closes).toEqual(['socket closed'])

    h.conn.close('second close')
    expect(h.closes).toEqual(['socket closed'])
  })
})

describe('RpcConnection write failures', () => {
  it('ends the connection when write throws instead of throwing back into the socket callback', async () => {
    const h = harness({ failFrom: 2 })
    expect(() => h.conn.notify('survives')).not.toThrow()
    expect(() => h.conn.notify('kills the transport')).not.toThrow()
    expect(() => h.conn.receive(JSON.stringify(REQUEST))).not.toThrow()

    expect(h.conn.isClosed).toBe(true)
    expect(h.closes).toEqual(['write failed'])

    const before = h.frames.length
    h.conn.notify('after')
    h.conn.request('agent/ask', { q: 1 }).catch(() => undefined)
    await settled()
    expect(h.frames).toHaveLength(before) // one failed write, then silence
  })

  it('rejects a request whose own frame could not be written', async () => {
    const h = harness({ failFrom: 1 })
    const pending = h.conn.request('session/request_permission', { a: 1 })
    await expect(pending).rejects.toThrow(/write failed/)
    expect(h.conn.isClosed).toBe(true)
    expect(h.closes).toEqual(['write failed'])
  })
})

describe('RpcConnection handler failures', () => {
  it('answers a plain Error with INTERNAL_ERROR and an RpcError with its own code and data', async () => {
    const h = harness()
    h.conn.on('boom', () => {
      throw new Error('the tool exploded')
    })
    h.conn.on('deny', () => {
      throw new RpcError('未授权：超出工作区范围', RPC_ERROR_CODE.INVALID_PARAMS, { rule: 'workspace' })
    })
    h.conn.on('async-boom', async () => {
      throw new RpcError('late failure') // RpcError's default code
    })
    h.conn.on('string-throw', () => {
      throw 'just a string' // a non-Error throw must still be answered, not leaked
    })

    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'boom' }))
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 'd1', method: 'deny' }))
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'async-boom' }))
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'string-throw' }))
    await settled()

    const frames = h.messages()
    expect(frames).toHaveLength(4)
    // Positions are not asserted: two handlers of different async depth legitimately
    // answer in completion order. What must hold is that every answer carries its own
    // caller's id and its own failure, so the pairing is keyed by id.
    const byId = new Map(frames.map((frame) => [String(frame.id), frame]))
    expect([...byId.keys()].sort()).toEqual(['11', '12', '13', 'd1'])
    expect(byId.get('11')!.error).toEqual({ code: RPC_ERROR_CODE.INTERNAL_ERROR, message: 'the tool exploded' })
    expect(byId.get('d1')!.error).toEqual({
      code: RPC_ERROR_CODE.INVALID_PARAMS,
      message: '未授权：超出工作区范围',
      data: { rule: 'workspace' },
    })
    expect(byId.get('12')!.error).toEqual({ code: RPC_ERROR_CODE.INTERNAL_ERROR, message: 'late failure' })
    expect(byId.get('13')!.error).toEqual({ code: RPC_ERROR_CODE.INTERNAL_ERROR, message: 'just a string' })
    expect(frames.every((frame) => frame.result === undefined)).toBe(true)
    expect(h.conn.isClosed).toBe(false) // a failing handler is not a failing connection
  })

  it('writes nothing when a notification handler throws', async () => {
    const h = harness()
    h.conn.on('boom', () => {
      throw new Error('noisy')
    })
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', method: 'boom' }))
    await settled()
    expect(h.frames).toEqual([])
    expect(h.conn.isClosed).toBe(false)
  })

  it('answers null (not undefined) for a handler that returns nothing, so the request is still closed out', async () => {
    const h = harness()
    h.conn.on('void', () => undefined)
    h.conn.receive(JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'void' }))
    await settled()
    expect(h.messages()).toEqual([{ jsonrpc: '2.0', id: 21, result: null }])
  })
})
