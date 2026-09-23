import { RPC_ERROR_CODE } from './protocol'

/**
 * One JSON-RPC 2.0 connection, independent of the bytes underneath it.
 *
 * This exists because an agent protocol is bidirectional: the client sends
 * requests, the server answers them, and the server also raises its own
 * requests (a permission prompt) and pushes notifications while an answer is
 * still outstanding. Those three kinds of outbound message have to be written
 * by one owner in one order, or a client that reads a single inbound stream can
 * park an in-flight request forever. So every frame leaves through `write` here,
 * and nothing else holds the socket.
 *
 * Two id spaces coexist without colliding: inbound ids are only echoed back into
 * a response and never looked up, while outbound ids are generated here and
 * matched against `pendingRequests`.
 */

export type RpcId = number | string

export interface RpcFailure { code: number; message: string; data?: unknown }

/** Thrown by a handler to answer with a specific JSON-RPC error code. */
export class RpcError extends Error {
  constructor(message: string, readonly code: number = RPC_ERROR_CODE.INTERNAL_ERROR, readonly data?: unknown) {
    super(message)
    this.name = 'RpcError'
  }
}

export type RpcHandler = (params: unknown, id: RpcId | undefined) => unknown | Promise<unknown>

export interface RpcConnectionOptions {
  /** Sends exactly one serialized JSON-RPC object. A throw ends the connection. */
  write: (frame: string) => void
  /** Notified for a frame that could not be handled at all, and on close. */
  onClosed?: (reason: string) => void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export class RpcConnection {
  private readonly handlers = new Map<string, RpcHandler>()
  private readonly pendingRequests = new Map<RpcId, PendingRequest>()
  private nextRequestId = 1
  private closed = false

  constructor(private readonly options: RpcConnectionOptions) {}

  on(method: string, handler: RpcHandler): this {
    this.handlers.set(method, handler)
    return this
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Handle exactly one inbound frame. Never rejects: a bad frame is answered
   * with an error envelope, and a handler failure is logged into its response,
   * because the caller is a socket data handler with nobody to catch a throw.
   */
  receive(text: string): void {
    if (this.closed) return

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch (e: any) {
      this.send({ jsonrpc: '2.0', id: null, error: { code: RPC_ERROR_CODE.PARSE_ERROR, message: `Parse error: ${e?.message ?? String(e)}` } })
      return
    }

    const message = payload as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      this.send({ jsonrpc: '2.0', id: null, error: { code: RPC_ERROR_CODE.INVALID_REQUEST, message: 'Invalid JSON-RPC 2.0 envelope.' } })
      return
    }

    // A reply to a request this side raised: settle it and stop.
    if (typeof message.method !== 'string') {
      if (message.id !== undefined && message.id !== null) this.settlePending(message.id as RpcId, message.error, message.result)
      return
    }

    const method = message.method
    const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : undefined
    const handler = this.handlers.get(method)

    if (!handler) {
      // A notification for an unknown method is ignored, per JSON-RPC; only a
      // request gets a METHOD_NOT_FOUND answer, since nobody is waiting on a
      // notification.
      if (id !== undefined) {
        this.send({ jsonrpc: '2.0', id, error: { code: RPC_ERROR_CODE.METHOD_NOT_FOUND, message: `Method "${method}" is not supported by this connection.` } })
      }
      return
    }

    void this.invoke(handler, method, message.params, id)
  }

  private async invoke(handler: RpcHandler, method: string, params: unknown, id: RpcId | undefined): Promise<void> {
    try {
      const result = await handler(params, id)
      if (id !== undefined && !this.closed) this.send({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (e: any) {
      if (id === undefined || this.closed) return
      const failure: RpcFailure = e instanceof RpcError
        ? { code: e.code, message: e.message, data: e.data }
        : { code: RPC_ERROR_CODE.INTERNAL_ERROR, message: e?.message ?? String(e) }
      this.send({ jsonrpc: '2.0', id, error: failure })
    }
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  /** Raise a request toward the client. Rejects when the connection closes first. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`The connection closed before "${method}" could be sent.`))
    const id: RpcId = `eva:${this.nextRequestId++}`
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  close(reason = 'closed'): void {
    if (this.closed) return
    this.closed = true
    this.rejectPending(reason)
    this.options.onClosed?.(reason)
  }

  private settlePending(id: RpcId, rawError: unknown, result: unknown): void {
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    this.pendingRequests.delete(id)
    if (rawError !== undefined && rawError !== null) {
      // A present-but-malformed `error` still means failure: resolving it would
      // let a garbage reply satisfy e.g. an unanswered permission request.
      const error = typeof rawError === 'object' ? rawError as { code?: number; message?: string } : {}
      const detail = error.message ?? (typeof rawError === 'object' ? 'no message' : `malformed error reply: ${String(rawError).slice(0, 120)}`)
      pending.reject(new Error(`Client error ${error.code ?? '?'}: ${detail}`))
      return
    }
    pending.resolve(result)
  }

  private rejectPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error(`The connection closed before request ${id} was answered (${reason}).`))
      this.pendingRequests.delete(id)
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed) return
    try {
      this.options.write(JSON.stringify(message))
    } catch {
      // The transport is gone. Report it once rather than throwing back into a
      // socket callback or a runner loop that cannot act on it.
      this.close('write failed')
    }
  }
}
