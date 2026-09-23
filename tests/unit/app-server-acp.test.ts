import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import WebSocket from 'ws'

/**
 * Real-WebSocket integration tests for the ACP door.
 *
 * The boundary being exercised is the one the phone terminal actually touches:
 * a `registerAcpUpgrade` gateway hung off a plain `http.createServer`, talked to
 * by a real `ws` client. Everything behind that boundary is a recorded stub
 * (`callMethod` stands in for Eva's `thread/*` + `turn/*` handlers) and the turn
 * itself is driven by broadcasting events on the hub, exactly as the app-server's
 * runner does. Booting the storage/provider stack would test Electron, not ACP.
 *
 * What the contract demands and these tests pin down:
 * - one inbound stream carries responses AND notifications, in causal order;
 * - one text frame is one complete JSON-RPC 2.0 object, binary frames are ignored;
 * - `initialize` is answered with a RESULT, and nothing session-shaped works
 *   before it;
 * - Eva's thread/turn vocabulary never inherits `full-access` from a network
 *   client, and approvals are visible and answerable over the same socket.
 */

// `activity-log` reaches Electron and the on-disk storage; the ACP path only
// uses it for breadcrumbs.
vi.mock('../../src/main/services/activity-log', () => ({ recordActivity: vi.fn() }))

import { SseHub } from '../../src/main/services/app-server/sse-hub'
import { ACP_PATH, registerAcpUpgrade, type AcpGateway } from '../../src/main/services/app-server/acp'
import { RpcConnection } from '../../src/main/services/app-server/rpc-connection'
import {
  EVENT_TYPE,
  RPC_ERROR_CODE,
  RPC_METHOD,
  type RpcMethod,
} from '../../src/main/services/app-server/protocol'
import { ACP_METHOD, ACP_PROTOCOL_VERSION, ACP_UPDATE } from '../../src/main/services/app-server/acp/protocol'
import {
  clearSessionApprovals,
  createLocalToolApproval,
  rejectAllPendingApprovalsForConversation,
  resolvePendingApproval,
  setApprovalRelay,
} from '../../src/main/services/tool-approval-policy'
import type { ToolApprovalRequest } from '../../src/main/agent-engine/agent-runner'

/** Injected instead of `app.getVersion()`, which needs a live Electron main process. */
const AGENT_VERSION = '0.0.0-acp-integration-test'
const BEARER_TOKEN = 'acp-test-bearer-token'

type Frame = {
  jsonrpc?: unknown
  id?: string | number | null
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

// -----------------------------------------------------------------------------
// The terminal: a real ws client that reads one stream and records every frame.
// -----------------------------------------------------------------------------

class AcpClient {
  readonly frames: Frame[] = []
  readonly textFrames: string[] = []
  readonly binaryFrames: Buffer[] = []
  /** Text frames that were not one parseable JSON object. Must stay empty. */
  readonly malformed: string[] = []
  /** Auto-answer the agent's permission requests; `ignore` leaves them open. */
  permissionAnswer: 'ignore' | 'allow_once' | 'allow_always' | 'reject_once' = 'ignore'

  private nextId = 1
  private arrivals: Array<() => void> = []
  private closedWith = ''

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw: Buffer, isBinary: boolean) => this.onMessage(raw, isBinary))
    ws.on('close', (code: number) => {
      this.closedWith = `closed (code ${code})`
      this.wake()
    })
    ws.on('error', () => {
      // `open()` surfaces the failure; a later one is always followed by `close`.
    })
  }

  static open(url: string, options: { headers?: Record<string, string>; protocols?: string | string[] } = {}): Promise<AcpClient> {
    const client = new AcpClient(
      new WebSocket(url, options.protocols, { handshakeTimeout: 5000, ...(options.headers ? { headers: options.headers } : {}) }),
    )
    return new Promise<AcpClient>((resolve, reject) => {
      client.ws.once('open', () => resolve(client))
      client.ws.once('error', (e: Error) => reject(e))
    })
  }

  private onMessage(raw: Buffer, isBinary: boolean): void {
    if (isBinary) {
      this.binaryFrames.push(raw)
      return
    }
    const text = raw.toString('utf-8')
    this.textFrames.push(text)
    let frame: Frame
    try {
      frame = JSON.parse(text) as Frame
    } catch {
      this.malformed.push(text)
      return
    }
    this.frames.push(frame)
    this.wake()
    // One owner for the answer, so a permission prompt is never parked by a test
    // that only came to look at the stream.
    if (frame.method === ACP_METHOD.SESSION_REQUEST_PERMISSION && this.permissionAnswer !== 'ignore') {
      this.send({
        jsonrpc: '2.0',
        id: frame.id as string,
        result: { outcome: { outcome: 'selected', optionId: this.permissionAnswer } },
      })
    }
  }

  private wake(): void {
    for (const resolve of this.arrivals.splice(0)) resolve()
  }

  private nextArrival(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.arrivals = this.arrivals.filter((w) => w !== finish)
        resolve()
      }, ms)
      const finish = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.arrivals.push(finish)
    })
  }

  send(payload: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(payload))
  }

  /** Sends a request and answers with the envelope that carries its id. */
  request(method: string, params?: unknown): Promise<Frame> {
    const id = this.nextId++
    this.send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })
    return this.until(`the response to ${method} #${id}`, (f) => f.id === id && ('result' in f || 'error' in f))
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  async until(label: string, predicate: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.frames.find(predicate)
      if (hit) return hit
      if (this.closedWith) throw new Error(`The socket ${this.closedWith} while waiting for ${label}. ${this.summary()}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`Timed out waiting for ${label}. ${this.summary()}`)
      await this.nextArrival(Math.min(remaining, 50))
    }
  }

  /** Every `session/update` payload received so far, in arrival order. */
  updates(sessionUpdate?: string): any[] {
    const list = this.frames
      .filter((f) => f.method === ACP_METHOD.SESSION_UPDATE)
      .map((f) => f.params as { sessionId: string; update: { sessionUpdate: string } })
    return sessionUpdate ? list.filter((p) => p.update.sessionUpdate === sessionUpdate) : list
  }

  /** Every frame in arrival order, reduced to what it is. */
  streamKinds(): string[] {
    return this.frames.map((f) => {
      if (f.method === ACP_METHOD.SESSION_UPDATE) return (f.params as any).update.sessionUpdate as string
      if (f.method) return f.method
      return f.error ? 'error' : 'response'
    })
  }

  summary(): string {
    const kinds = this.frames.map((f) => f.method
      ?? (f.error ? `error#${f.id}(${f.error.code})` : `result#${f.id}`))
    return `Frames so far: ${kinds.join(' | ') || 'none'}.`
  }

  close(): Promise<void> {
    if (this.ws.readyState >= WebSocket.CLOSING) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve())
      this.ws.close()
    })
  }

  terminate(): void {
    if (this.ws.readyState < WebSocket.CLOSING) this.ws.terminate()
  }
}

// -----------------------------------------------------------------------------
// Server harness: a real HTTP server + the /acp gateway + a recording stub.
// -----------------------------------------------------------------------------

interface Harness {
  hub: SseHub
  gateway: AcpGateway
  port: number
  calls: Array<{ method: RpcMethod; params: unknown }>
  /** Params of every recorded call to `method`, in arrival order. */
  callsOf(method: RpcMethod): unknown[]
  countOf(method: RpcMethod): number
  waitForCall(method: RpcMethod, timeoutMs?: number): Promise<unknown[]>
  url(path?: string): string
  connect(options?: { headers?: Record<string, string>; protocols?: string | string[]; path?: string }): Promise<AcpClient>
  broadcastTurn(conversationId: string, type: string, data: Record<string, unknown>): void
  /** Runs the ACP handshake and opens one session; returns its session id. */
  openSession(client: AcpClient, cwd?: string): Promise<string>
  teardown(): Promise<void>
}

const harnesses: Harness[] = []

async function startHarness(overrides: { requireAuth?: boolean; bearerToken?: string } = {}): Promise<Harness> {
  const hub = new SseHub()
  const bearerToken = overrides.bearerToken ?? BEARER_TOKEN
  const requireAuth = overrides.requireAuth ?? true
  const calls: Array<{ method: RpcMethod; params: unknown }> = []
  const callWaiters: Array<() => void> = []
  const clients: AcpClient[] = []
  const sessionIds: string[] = []
  let createdThreads = 0

  const callMethod = async (method: RpcMethod, params?: unknown): Promise<unknown> => {
    calls.push({ method, params })
    for (const wake of callWaiters.splice(0)) wake()
    const request = (params ?? {}) as Record<string, unknown>
    if (method === RPC_METHOD.THREAD_START) {
      createdThreads += 1
      const id = `conv-acp-${createdThreads}`
      sessionIds.push(id)
      return { id, title: request.title, createdAt: 1 }
    }
    if (method === RPC_METHOD.TURN_START) return { threadId: request.threadId, startedAt: 1, status: 'running' }
    if (method === RPC_METHOD.TURN_INTERRUPT) return { threadId: request.threadId, interrupted: true }
    return { ok: true }
  }

  const server = http.createServer((_req, res) => {
    res.statusCode = 404
    res.end('only /acp is served over a WebSocket here')
  })
  const gateway = registerAcpUpgrade(server, { hub, callMethod, bearerToken, requireAuth, agentVersion: AGENT_VERSION })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port

  const harness: Harness = {
    hub,
    gateway,
    port,
    calls,
    callsOf: (method) => calls.filter((c) => c.method === method).map((c) => c.params),
    countOf: (method) => calls.filter((c) => c.method === method).length,
    async waitForCall(method, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const hits = harness.callsOf(method)
        if (hits.length) return hits
        if (Date.now() >= deadline) {
          throw new Error(`No call to "${method}" reached the app-server. Recorded: ${calls.map((c) => c.method).join(', ') || 'nothing'}.`)
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            const i = callWaiters.indexOf(finish)
            if (i >= 0) callWaiters.splice(i, 1)
            resolve()
          }, 25)
          const finish = (): void => {
            clearTimeout(timer)
            resolve()
          }
          callWaiters.push(finish)
        })
      }
    },
    url: (path = ACP_PATH) => `ws://127.0.0.1:${port}${path}`,
    async connect(options = {}) {
      // A terminal that knows the token sends it; the guard tests that do not are
      // the ones opening the socket directly.
      const headers = requireAuth
        ? { Authorization: `Bearer ${bearerToken}`, ...(options.headers ?? {}) }
        : options.headers
      const client = await AcpClient.open(harness.url(options.path), { ...options, ...(headers ? { headers } : {}) })
      clients.push(client)
      return client
    },
    broadcastTurn: (conversationId, type, data) => hub.broadcast({
      topic: 'turn',
      conversationId,
      type,
      data,
      ts: Date.now(),
    }),
    async openSession(client, cwd) {
      const initialized = await client.request(ACP_METHOD.INITIALIZE, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      if (initialized.error) throw new Error(`initialize failed: ${initialized.error.code} ${initialized.error.message}`)
      const created = await client.request(ACP_METHOD.SESSION_NEW, { ...(cwd === undefined ? {} : { cwd }), mcpServers: [] })
      if (created.error) throw new Error(`session/new failed: ${created.error.code} ${created.error.message}`)
      return (created.result as { sessionId: string }).sessionId
    },
    async teardown() {
      for (const client of clients) client.terminate()
      gateway.close()
      await new Promise<void>((resolve) => {
        const settle = (): void => {
          clearTimeout(guard)
          resolve()
        }
        const guard = setTimeout(settle, 1000)
        guard.unref?.()
        server.close(settle)
        server.closeAllConnections()
      })
      // Approvals live in a module registry: a pending card owns a timeout that
      // would otherwise keep the process alive past this file.
      for (const session of sessionIds) {
        setApprovalRelay(session, null)
        clearSessionApprovals(session)
        rejectAllPendingApprovalsForConversation(session, 'test teardown')
      }
    },
  }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.teardown()
})

function approvalRequest(toolCallId: string, command: string): ToolApprovalRequest {
  return { toolCall: { id: toolCallId, name: 'execute_command', arguments: { command } }, workspacePath: 'D:\\work\\demo' }
}

/** The framing contract: every text frame received was exactly one JSON-RPC object. */
function expectSingleObjectFrames(client: AcpClient): void {
  expect(client.malformed).toEqual([])
  expect(client.binaryFrames).toEqual([])
  expect(client.textFrames).toHaveLength(client.frames.length)
  expect(client.textFrames.some((t) => t.includes('\n'))).toBe(false)
}

// -----------------------------------------------------------------------------
// 1. initialize
// -----------------------------------------------------------------------------

describe('ACP handshake over a real WebSocket', () => {
  it('answers initialize with a result the terminal treats as connected', async () => {
    const h = await startHarness()
    // Offering subprotocols must not gate the handshake, and Eva never requires one.
    const client = await h.connect({ protocols: ['acp', 'v1.acp'] })
    const plain = await h.connect()
    // The terminal sends no `Sec-WebSocket-Protocol`, so none comes back: nothing
    // is negotiated that it would have to accept.
    expect(plain.ws.protocol).toBe('')

    const frame = await client.request(ACP_METHOD.INITIALIZE, { protocolVersion: 99, clientCapabilities: {} })

    expect(frame.jsonrpc).toBe('2.0')
    expect(frame.error).toBeUndefined()
    expect(frame.result).toEqual({
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      authMethods: [],
      agentInfo: { name: 'eva', title: 'Eva', version: AGENT_VERSION },
    })
    // The version is the injected one, never a number baked into the facade.
    expect(frame.result.agentInfo.version).toBe(AGENT_VERSION)
    expect(typeof frame.result.agentInfo.version).toBe('string')
    // The handshake is a plain request/response on the same stream as everything else.
    expectSingleObjectFrames(client)
  })

  it('refuses a session before initialize and forwards a bounded workspace after it', async () => {
    const h = await startHarness()
    const client = await h.connect()

    const early = await client.request(ACP_METHOD.SESSION_NEW, { cwd: 'D:\\work\\demo', mcpServers: [] })
    expect(early.error?.code).toBe(RPC_ERROR_CODE.NOT_INITIALIZED)
    expect(early.error?.code).toBe(-32002)
    expect(h.countOf(RPC_METHOD.THREAD_START)).toBe(0)

    await client.request(ACP_METHOD.INITIALIZE, { protocolVersion: ACP_PROTOCOL_VERSION })
    const created = await client.request(ACP_METHOD.SESSION_NEW, { cwd: '  D:\\work\\demo  ', mcpServers: [] })
    expect(created.error).toBeUndefined()
    expect(typeof created.result.sessionId).toBe('string')
    expect(created.result.sessionId).toBeTruthy()

    const [startParams] = h.callsOf(RPC_METHOD.THREAD_START) as Array<Record<string, unknown>>
    expect(startParams).toEqual({
      title: 'ACP session',
      workspacePath: 'D:\\work\\demo',
      permissionLevel: 'workspace',
    })
    // A network client may never reach past the workspace it declared, and the
    // `full-access` default must not be inheritable through params either.
    expect(h.calls.every((c) => (c.params as any)?.permissionLevel !== 'full-access')).toBe(true)

    // No cwd means no workspacePath key at all, not an empty one.
    const bare = await client.request(ACP_METHOD.SESSION_NEW, {})
    expect(bare.error).toBeUndefined()
    const bareParams = h.callsOf(RPC_METHOD.THREAD_START)[1] as Record<string, unknown>
    expect('workspacePath' in bareParams).toBe(false)
    expect(bareParams.permissionLevel).toBe('workspace')

    // Client-supplied MCP servers are not supported, and must not be created.
    const refused = await client.request(ACP_METHOD.SESSION_NEW, { cwd: 'D:\\work\\demo', mcpServers: [{ name: 'extra' }] })
    expect(refused.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS)
    expect(refused.error?.code).toBe(-32602)
    expect(h.countOf(RPC_METHOD.THREAD_START)).toBe(2)
  })
})

// -----------------------------------------------------------------------------
// 2. one turn, one stream
// -----------------------------------------------------------------------------

describe('ACP prompt over a real WebSocket', () => {
  it('streams one turn as session/update frames and answers the prompt request last', async () => {
    const h = await startHarness()
    const client = await h.connect()
    const sessionId = await h.openSession(client, 'D:\\work\\demo')

    const promptResponse = client.request(ACP_METHOD.SESSION_PROMPT, {
      sessionId,
      prompt: [{ type: 'text', text: '跑一遍测试' }],
    })
    const [turnParams] = await h.waitForCall(RPC_METHOD.TURN_START) as Array<Record<string, unknown>>
    expect(turnParams).toEqual({ threadId: sessionId, message: '跑一遍测试' })

    h.broadcastTurn(sessionId, EVENT_TYPE.TURN_TEXT_DELTA, { content: '开始' })
    h.broadcastTurn(sessionId, EVENT_TYPE.TURN_TEXT_DELTA, { content: '执行。' })
    await client.until('two message chunks', () => client.updates(ACP_UPDATE.AGENT_MESSAGE_CHUNK).length === 2)

    h.broadcastTurn(sessionId, EVENT_TYPE.TURN_PROGRESS, {
      id: 'p-plan',
      kind: 'plan',
      content: '- 读取实现\n- 运行窄测\n- 汇总结果',
      timestamp: 1,
    })
    h.broadcastTurn(sessionId, EVENT_TYPE.TURN_PROGRESS, { id: 'p-step-1', kind: 'step', content: '已读取实现', item: 1, timestamp: 2 })
    h.broadcastTurn(sessionId, EVENT_TYPE.TURN_PROGRESS, { id: 'p-step-2', kind: 'step', content: '窄测通过', item: 2, timestamp: 3 })
    h.broadcastTurn(sessionId, EVENT_TYPE.TURN_PROGRESS, { id: 'p-step-3', kind: 'step', content: '已汇总', item: 3, timestamp: 4 })

    h.broadcastTurn(sessionId, EVENT_TYPE.TURN_TOOL_CALL_START, {
      toolCall: { id: 'call-1', name: 'execute_command', arguments: { command: 'npx vitest run' } },
    })
    h.broadcastTurn(sessionId, EVENT_TYPE.TURN_TOOL_RESULT, { toolCallId: 'call-1', toolName: 'execute_command', result: '566 passed', isError: false })
    h.broadcastTurn(sessionId, EVENT_TYPE.TURN_COMPLETED, { threadId: sessionId })

    const answered = await promptResponse
    expect(answered.result).toEqual({ stopReason: 'end_turn' })

    // Chunks: one message id shared by the whole reply, text preserved verbatim.
    const chunks = client.updates(ACP_UPDATE.AGENT_MESSAGE_CHUNK)
    expect(chunks.map((p: any) => p.update.content)).toEqual([{ type: 'text', text: '开始' }, { type: 'text', text: '执行。' }])
    expect(new Set(chunks.map((p: any) => p.update.messageId)).size).toBe(1)
    expect(chunks.every((p: any) => p.sessionId === sessionId)).toBe(true)

    // Tools: `tool_call` opens, `tool_call_update` closes the same toolCallId.
    const toolCalls = client.updates(ACP_UPDATE.TOOL_CALL)
    const toolUpdates = client.updates(ACP_UPDATE.TOOL_CALL_UPDATE)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].update.toolCall).toEqual({
      toolCallId: 'call-1',
      title: '执行命令 npx vitest run',
      kind: 'execute',
      status: 'in_progress',
    })
    expect(toolUpdates).toHaveLength(1)
    expect(toolUpdates[0].update).toEqual({ sessionUpdate: ACP_UPDATE.TOOL_CALL_UPDATE, toolCallId: 'call-1', status: 'completed' })

    // The plan ticks as the step reports land, and ends on the truth.
    const snapshots = client.updates(ACP_UPDATE.PLAN)
    expect(snapshots.map((p: any) => p.update.entries.map((e: any) => e.status))).toEqual([
      ['in_progress', 'pending', 'pending'],
      ['completed', 'in_progress', 'pending'],
      ['completed', 'completed', 'in_progress'],
      ['completed', 'completed', 'completed'],
      // The closing snapshot after `turn/completed` clears the streaming marker.
      ['completed', 'completed', 'completed'],
    ])
    expect(snapshots[0].update.entries.map((e: any) => e.content)).toEqual(['读取实现', '运行窄测', '汇总结果'])
    expect(snapshots.every((p: any) => p.update.entries.every((e: any) => e.priority === 'medium'))).toBe(true)

    // Progress reports also reach the client as thought chunks, so a plan-less
    // round is still narrated.
    expect(client.updates(ACP_UPDATE.AGENT_THOUGHT_CHUNK).length).toBeGreaterThanOrEqual(4)

    // One inbound stream: responses and notifications share it in causal order,
    // and the prompt request is settled after every update it caused.
    expect(client.streamKinds()).toEqual([
      'response', // initialize
      'response', // session/new
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_thought_chunk', 'plan', // plan reported
      'agent_thought_chunk', 'plan', // step 1 ticks
      'agent_thought_chunk', 'plan', // step 2 ticks
      'agent_thought_chunk', 'plan', // step 3 ticks
      'tool_call',
      'tool_call_update',
      'plan', // closing snapshot, streaming marker cleared
      'response', // the prompt answer, last
    ])
    expect(client.frames[client.frames.length - 1]).toBe(answered)

    // One text frame = one complete object: nothing was split, nothing batched,
    // and the server never sent a binary frame.
    expect(client.malformed).toEqual([])
    expect(client.binaryFrames).toEqual([])
    expect(client.textFrames).toHaveLength(client.frames.length)
    expect(client.textFrames.some((t) => t.includes('\n'))).toBe(false)
  })

  it('rejects a prompt for an unknown session or with no text block', async () => {
    const h = await startHarness()
    const client = await h.connect()
    const sessionId = await h.openSession(client, 'D:\\work\\demo')

    const unknown = await client.request(ACP_METHOD.SESSION_PROMPT, { sessionId: 'conv-nope', prompt: [{ type: 'text', text: 'hi' }] })
    expect(unknown.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS)
    expect(unknown.error?.code).toBe(-32602)

    const noText = await client.request(ACP_METHOD.SESSION_PROMPT, { sessionId, prompt: [{ type: 'image', mimeType: 'image/png' }] })
    expect(noText.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS)

    const emptyText = await client.request(ACP_METHOD.SESSION_PROMPT, { sessionId, prompt: [] })
    expect(emptyText.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS)
    // Nothing was started for a prompt that failed its params check.
    expect(h.countOf(RPC_METHOD.TURN_START)).toBe(0)
    expect(h.countOf(RPC_METHOD.TURN_INTERRUPT)).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// 3. approvals are visible and answerable on the same socket
// -----------------------------------------------------------------------------

describe('ACP approval round trip', () => {
  it('raises session/request_permission and answers it through the shared registry', async () => {
    const h = await startHarness()
    const client = await h.connect()
    const sessionId = await h.openSession(client, 'D:\\work\\demo')
    const promptResponse = client.request(ACP_METHOD.SESSION_PROMPT, { sessionId, prompt: [{ type: 'text', text: '删掉临时目录' }] })
    await h.waitForCall(RPC_METHOD.TURN_START)

    // Exactly the door the desktop runner uses: a locally built approval, with no
    // window, for the conversation the facade is driving.
    const approve = createLocalToolApproval({
      conversationId: sessionId,
      window: null,
      config: { policy: 'safe', timeoutMs: 30_000 },
    })
    const decision = approve(approvalRequest('call-approve', 'Remove-Item -Recurse temp'))

    const prompted = await client.until('a permission request', (f) => f.method === ACP_METHOD.SESSION_REQUEST_PERMISSION)
    expect(prompted.jsonrpc).toBe('2.0')
    expect(typeof prompted.id).toBe('string')
    const params = prompted.params as any
    expect(params.sessionId).toBe(sessionId)
    expect(params.toolCall).toEqual({ toolCallId: 'call-approve', title: 'Run command in terminal', kind: 'execute', status: 'pending' })
    expect(params.options).toEqual([
      { optionId: 'allow_once', name: '允许本次', kind: 'allow_once' },
      { optionId: 'allow_always', name: '本会话内都允许', kind: 'allow_always' },
      { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
    ])
    expect(params._meta.toolName).toBe('execute_command')
    expect(params._meta.category).toBe('terminal-command')
    expect(typeof params._meta.approvalId).toBe('string')

    client.send({ jsonrpc: '2.0', id: prompted.id as string, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } })
    await expect(decision).resolves.toEqual({ approved: true })

    h.broadcastTurn(sessionId, EVENT_TYPE.TURN_COMPLETED, { threadId: sessionId })
    await expect(promptResponse).resolves.toMatchObject({ result: { stopReason: 'end_turn' } })
    // The prompt owned the relay only while it ran: with no window left to ask,
    // the next call falls back to the headless denial instead of the ACP socket.
    const afterPrompt = createLocalToolApproval({ conversationId: sessionId, window: null, config: { policy: 'safe', timeoutMs: 30_000 } })
    await expect(afterPrompt(approvalRequest('call-after-turn', 'ls')))
      .resolves.toEqual({ approved: false, message: 'No renderer available to approve this tool call; denied by policy.' })
  })

  it('a registered relay wins over a null window and a dead relay denies the call', async () => {
    const conversationId = 'conv-relay-precedence'
    const delivered: string[] = []
    setApprovalRelay(conversationId, (approval) => {
      delivered.push(approval.toolCallId)
      return false
    })
    const approve = createLocalToolApproval({ conversationId, window: null, config: { policy: 'safe', timeoutMs: 30_000 } })

    // The relay took the card (a null window alone would have denied silently),
    // and `false` means "the client could not receive it": denied on the spot.
    await expect(approve(approvalRequest('call-dead-relay', 'npm publish')))
      .resolves.toEqual({ approved: false, message: '审批卡片无法送达该客户端，本次调用已按拒绝处理。' })
    expect(delivered).toEqual(['call-dead-relay'])
    setApprovalRelay(conversationId, null)
    clearSessionApprovals(conversationId)
  })

  it('registers the card before handing it to the relay', async () => {
    const conversationId = 'conv-relay-ordering'
    let answerLanded: boolean | null = null
    setApprovalRelay(conversationId, (approval) => {
      // Answering synchronously, from inside the delivery call, only resolves if
      // the id was already registered as pending.
      answerLanded = resolvePendingApproval(approval.id, true)
      return true
    })
    const approve = createLocalToolApproval({ conversationId, window: null, config: { policy: 'safe', timeoutMs: 30_000 } })
    const decision = approve(approvalRequest('call-ordering', 'git push'))

    await expect(decision).resolves.toEqual({ approved: true })
    expect(answerLanded).toBe(true)
    setApprovalRelay(conversationId, null)
    clearSessionApprovals(conversationId)
  })
})

// -----------------------------------------------------------------------------
// 4. cancel, dispose and the guards
// -----------------------------------------------------------------------------

describe('ACP cancellation and teardown', () => {
  it('treats session/cancel as a notification, forwards turn/interrupt and stops the turn as cancelled', async () => {
    const h = await startHarness()
    const client = await h.connect()
    const sessionId = await h.openSession(client, 'D:\\work\\demo')
    const promptResponse = client.request(ACP_METHOD.SESSION_PROMPT, { sessionId, prompt: [{ type: 'text', text: '慢慢来' }] })
    await h.waitForCall(RPC_METHOD.TURN_START)

    // A notification carries no id, so nothing may be answered for it.
    client.notify(ACP_METHOD.SESSION_CANCEL, { sessionId })
    await h.waitForCall(RPC_METHOD.TURN_INTERRUPT)
    expect(h.callsOf(RPC_METHOD.TURN_INTERRUPT)).toEqual([{ threadId: sessionId }])
    expectSingleObjectFrames(client)

    h.broadcastTurn(sessionId, EVENT_TYPE.TURN_COMPLETED, { threadId: sessionId })
    const answered = await promptResponse
    expect(answered.result).toEqual({ stopReason: 'cancelled' })
    expect(client.frames.filter((f) => f.id === undefined && f.error)).toEqual([])
    // The cancel was a notification: no envelope echoed its (absent) id.
    expect(client.frames.some((f) => f.id === null)).toBe(false)
  })

  it('disposes with the socket: the turn is interrupted and an unanswered approval is denied', async () => {
    const h = await startHarness()
    const client = await h.connect()
    const sessionId = await h.openSession(client, 'D:\\work\\demo')
    // The prompt is abandoned on purpose: the socket goes away before any answer.
    const abandonedPrompt = client.request(ACP_METHOD.SESSION_PROMPT, { sessionId, prompt: [{ type: 'text', text: '别跑完' }] })
    await h.waitForCall(RPC_METHOD.TURN_START)

    const approve = createLocalToolApproval({ conversationId: sessionId, window: null, config: { policy: 'safe', timeoutMs: 30_000 } })
    const decision = approve(approvalRequest('call-orphan', 'format c:'))
    await client.until('the permission prompt to reach the client', (f) => f.method === ACP_METHOD.SESSION_REQUEST_PERMISSION)

    await client.close()
    // The terminal's own wait fails instead of hanging on a dead connection.
    await expect(abandonedPrompt).rejects.toThrow(/closed/i)

    // Nobody is left to answer, so the pending card must not sit until its timeout.
    const denied = await decision
    expect(denied.approved).toBe(false)
    expect(denied.message).toBe('ACP 连接已断开（socket closed），未完成审批按拒绝处理。')
    await h.waitForCall(RPC_METHOD.TURN_INTERRUPT)
    expect(h.callsOf(RPC_METHOD.TURN_INTERRUPT)).toEqual([{ threadId: sessionId }])
    expect(h.countOf(RPC_METHOD.TURN_INTERRUPT)).toBe(1)
  })

  it('does not interrupt a session the client had already cancelled', async () => {
    const h = await startHarness()
    const client = await h.connect()
    const sessionId = await h.openSession(client, 'D:\\work\\demo')
    const prompt = client.request(ACP_METHOD.SESSION_PROMPT, { sessionId, prompt: [{ type: 'text', text: '停' }] })
    await h.waitForCall(RPC_METHOD.TURN_START)
    client.notify(ACP_METHOD.SESSION_CANCEL, { sessionId })
    await h.waitForCall(RPC_METHOD.TURN_INTERRUPT)
    await client.close()
    // The disconnect must not raise a second interrupt for the same turn.
    expect(h.countOf(RPC_METHOD.TURN_INTERRUPT)).toBe(1)
    // And the terminal learns that its open prompt died with the connection
    // instead of waiting for an answer that can no longer be written.
    await expect(prompt).rejects.toThrow(/closed/i)
  })
})

describe('ACP connection guards', () => {
  it('serves only /acp over a WebSocket', async () => {
    const h = await startHarness()
    await expect(AcpClient.open(h.url('/v1/events'))).rejects.toThrow(/421/)
    const client = await h.connect()
    await client.request(ACP_METHOD.INITIALIZE, { protocolVersion: ACP_PROTOCOL_VERSION })
    expect(h.gateway.connections()).toBe(1)
  })

  it('requires the bearer token when auth is on', async () => {
    const h = await startHarness({ requireAuth: true })
    await expect(AcpClient.open(h.url())).rejects.toThrow(/401/)
    await expect(AcpClient.open(h.url(), { headers: { Authorization: `Bearer ${BEARER_TOKEN}x` } })).rejects.toThrow(/401/)

    const client = await h.connect({ headers: { Authorization: `Bearer ${BEARER_TOKEN}` } })
    const frame = await client.request(ACP_METHOD.INITIALIZE, { protocolVersion: ACP_PROTOCOL_VERSION })
    expect(frame.error).toBeUndefined()
    expect(h.gateway.connections()).toBe(1)
  })

  it('refuses an Origin-carrying client when auth is off, and only then accepts a native one', async () => {
    // This is the pairing that has to hold together: with the token check off,
    // `Origin` is the only thing separating the phone on the other end of
    // `adb reverse` from any web page that can reach the loopback port.
    const h = await startHarness({ requireAuth: false })
    await expect(AcpClient.open(h.url(), { headers: { Origin: 'http://evil.example' } })).rejects.toThrow(/403/)

    const client = await h.connect()
    const frame = await client.request(ACP_METHOD.INITIALIZE, { protocolVersion: ACP_PROTOCOL_VERSION })
    expect(frame.error).toBeUndefined()
    expect(h.gateway.connections()).toBe(1)
  })

  it('ignores a binary frame and keeps serving the same socket', async () => {
    const h = await startHarness()
    const client = await h.connect()

    // Garbage in a binary frame: treated as text, this would answer a parse error.
    client.ws.send(Buffer.from('not json at all'))
    const frame = await client.request(ACP_METHOD.INITIALIZE, { protocolVersion: ACP_PROTOCOL_VERSION })
    expect(frame.error).toBeUndefined()
    expect(client.frames.some((f) => f.error?.code === RPC_ERROR_CODE.PARSE_ERROR)).toBe(false)
    expect(client.frames.some((f) => f.error?.code === RPC_ERROR_CODE.INVALID_REQUEST)).toBe(false)
    // The server stayed text-only.
    expect(client.binaryFrames).toEqual([])

    const sessionId = await h.openSession(client, 'D:\\work\\demo')
    expect(sessionId).toBeTruthy()
  })

  it('answers an unknown method with METHOD_NOT_FOUND and ignores an unknown notification', async () => {
    const h = await startHarness()
    const client = await h.connect()

    client.notify('session/does_not_exist', { sessionId: 'x' })
    const unknown = await client.request('session/does_not_exist', {})
    expect(unknown.error?.code).toBe(RPC_ERROR_CODE.METHOD_NOT_FOUND)
    expect(unknown.error?.code).toBe(-32601)
    // The notification had nobody waiting for it, so it earned no envelope: the
    // only error on the wire is the one answering the request above.
    expect(client.frames.filter((f) => f.error?.code === RPC_ERROR_CODE.METHOD_NOT_FOUND)).toHaveLength(1)
    expect(client.frames.filter((f) => f.id === undefined && f.error)).toHaveLength(0)
  })

  it('answers a broken text frame with an error and keeps the socket usable', async () => {
    const h = await startHarness()
    const client = await h.connect()

    // A truncated object in a text frame: unparseable text still earns a
    // PARSE_ERROR, and there is no id to echo, so it is null.
    client.ws.send('{"jsonrpc": "2.0", "id": 7, "method": ')
    const parseError = await client.until('a parse error', (f) => f.error?.code === RPC_ERROR_CODE.PARSE_ERROR)
    expect(parseError.id).toBe(null)

    // Well-formed JSON that is not a JSON-RPC 2.0 envelope: invalid request.
    client.send({ id: 8, method: 'initialize' })
    const invalid = await client.until('an invalid-request answer', (f) => f.error?.code === RPC_ERROR_CODE.INVALID_REQUEST)
    expect(invalid.id).toBe(null)

    // Neither answer cost the connection.
    const frame = await client.request(ACP_METHOD.INITIALIZE, { protocolVersion: ACP_PROTOCOL_VERSION })
    expect(frame.result.protocolVersion).toBe(ACP_PROTOCOL_VERSION)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
  })
})

// -----------------------------------------------------------------------------
// 5. fan-out must never throw back into a broadcast
// -----------------------------------------------------------------------------

describe('event fan-out safety', () => {
  it('a sink that throws, and closeAll, never throw out of broadcast', () => {
    const hub = new SseHub()
    const delivered: string[] = []
    hub.subscribe(() => { throw new Error('the connection closed mid-broadcast') })
    hub.subscribe((event) => { delivered.push(event.type) })

    expect(() => hub.broadcast({ topic: 'turn', type: EVENT_TYPE.TURN_TEXT_DELTA, data: { content: 'x' }, ts: 1 })).not.toThrow()
    expect(delivered).toEqual([EVENT_TYPE.TURN_TEXT_DELTA])

    hub.closeAll()
    expect(hub.clientCount()).toBe(0)
    expect(() => hub.broadcast({ topic: 'turn', type: EVENT_TYPE.TURN_COMPLETED, data: {}, ts: 2 })).not.toThrow()
  })

  it('a failed socket write closes the connection instead of throwing at the broadcaster', () => {
    const hub = new SseHub()
    const attempts: string[] = []
    // Mirrors the gateway's writer, which throws once the socket is not OPEN.
    const connection = new RpcConnection({
      write: (frame) => {
        attempts.push(frame)
        throw new Error('The ACP socket no longer accepts writes.')
      },
    })
    hub.subscribe((event) => connection.notify(ACP_METHOD.SESSION_UPDATE, { sessionId: 'conv-x', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: event.type } } }))

    expect(() => hub.broadcast({ topic: 'turn', conversationId: 'conv-x', type: EVENT_TYPE.TURN_TEXT_DELTA, data: { content: 'x' }, ts: 1 })).not.toThrow()
    expect(attempts).toHaveLength(1)
    expect(connection.isClosed).toBe(true)
    // A closed connection stops writing rather than failing every later event.
    expect(() => hub.broadcast({ topic: 'turn', conversationId: 'conv-x', type: EVENT_TYPE.TURN_COMPLETED, data: {}, ts: 2 })).not.toThrow()
    expect(attempts).toHaveLength(1)
  })
})
