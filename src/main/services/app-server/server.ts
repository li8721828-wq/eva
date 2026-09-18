import http, { type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { SseHub } from './sse-hub'
import type { ChatServices } from '../../ipc/conversation'
import type { RpcEnvelope, RpcErr, RpcMethod, RpcMethodHandler, ServerEvent, ServerStatus } from './protocol'
import { RPC_METHOD } from './protocol'
import { getStorage } from '../../storage'
import { BrowserWindow } from 'electron'
import { AgentRunner } from '../../agent-engine/agent-runner'
import { ContextManager } from '../../agent-engine/context'
import { v4 as uuidv4 } from 'uuid'
import { sanitizeToolHistory } from '../../agent-engine/tool-history'
import { resolveEffectiveAgentConfig } from '../effective-agent-config'
import { createLocalToolApproval, rejectAllPendingApprovalsForConversation, resolvePendingApproval } from '../tool-approval-policy'
import { DEFAULT_AUTOMATION_CONFIG } from '../../../shared/types/automation'
import { recordActivity } from '../activity-log'
import type { AgentConfig } from '../../../shared/types/agent'
import type { ChatMessage } from '../../../shared/types/conversation'
import { ConversationLifecycleService } from '../conversation-lifecycle-service'

// -----------------------------------------------------------------------------
// ServerStatus singleton holds the runtime state of the HTTP server.
// -----------------------------------------------------------------------------

let status: ServerStatus = {
  running: false,
  host: '127.0.0.1',
  port: null,
  bearerToken: null,
  startedAt: null,
  lastError: null,
  loopbackOnly: true,
  connections: 0,
}

export function getAppServerStatus(): ServerStatus {
  return { ...status }
}

// -----------------------------------------------------------------------------
// JSON-RPC errors
// -----------------------------------------------------------------------------

const RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  NOT_RUNNING: -32002,
  ALREADY_RUNNING: -32003,
} as const

function rpcError(id: unknown, code: number, message: string, data?: unknown): RpcErr {
  return { jsonrpc: '2.0', id: (id as RpcEnvelope['id']) ?? null, error: { code, message, data } }
}

// -----------------------------------------------------------------------------
// HTTP server plumbing
// -----------------------------------------------------------------------------

interface ServerDeps {
  chatServices: ChatServices
  hub: SseHub
  bearerToken: string
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || 'null')) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
}

function checkAuth(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  return header === `Bearer ${token}`
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

// -----------------------------------------------------------------------------
// JSON-RPC method handlers
// -----------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: '2.0'
  id?: unknown
  method?: string
  params?: unknown
}

function isRpcRequest(x: unknown): x is RpcRequest {
  return Boolean(x && typeof x === 'object' && (x as RpcRequest).jsonrpc === '2.0')
}

function withChatServices<T>(services: ChatServices | undefined, fn: (s: ChatServices) => Promise<T> | T): Promise<T> | T {
  if (!services) throw new Error('Chat services are not available; the app-server requires the renderer\'s main process services to be wired.')
  return Promise.resolve(fn(services))
}

interface TurnSession {
  conversationId: string
  abort: () => void
  done: Promise<{ finishReason?: string; usage?: unknown }>
}

const activeTurnsByAppServer = new Map<string, TurnSession>()

function buildMethodHandlers(deps: ServerDeps): Map<RpcMethod, RpcMethodHandler> {
  const { chatServices: services, hub } = deps

  const handlers = new Map<RpcMethod, RpcMethodHandler>()

  handlers.set(RPC_METHOD.SERVER_STATUS, async () => ({ ...status, connections: hub.clientCount() }))

  handlers.set(RPC_METHOD.SERVER_SHUTDOWN, async () => {
    setTimeout(() => serverRef?.close(), 100)
    return { ok: true }
  })

  handlers.set(RPC_METHOD.THREAD_LIST, async () => {
    return withChatServices(services, async (s) => {
      const convs = await getStorage().conversations.listConversations()
      return convs.map((c) => ({
        id: c.id,
        title: c.title,
        agentId: c.agentId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        archived: Boolean(c.archived),
        executionStatus: c.executionStatus,
      }))
    })
  })

  handlers.set(RPC_METHOD.THREAD_GET, async (params) => {
    return withChatServices(services, async (s) => {
      const { threadId } = (params ?? {}) as { threadId?: string }
      if (!threadId) throw new Error('threadId is required')
      const conversation = await getStorage().conversations.getConversation(threadId)
      if (!conversation) throw new Error(`Thread ${threadId} not found`)
      const messages = await getStorage().conversations.getMessages(threadId)
      return { conversation, messages }
    })
  })

  handlers.set(RPC_METHOD.THREAD_START, async (params) => {
    return withChatServices(services, async (s) => {
      const { agentId, title, workspaceId } = (params ?? {}) as { agentId?: string; title?: string; workspaceId?: string }
      const lifecycle = new ConversationLifecycleService(s.storage)
      const conversation = await lifecycle.create({
        title: title || 'App-Server thread',
        agentId,
        workspaceId,
      })
      void recordActivity({
        category: 'system',
        action: 'app_server.thread_started',
        status: 'info',
        summary: `App-Server thread ${conversation.id} started.`,
        conversationId: conversation.id,
      })
      return { id: conversation.id, agentId: conversation.agentId, title: conversation.title, createdAt: conversation.createdAt }
    })
  })

  handlers.set(RPC_METHOD.TURN_START, async (params) => {
    return withChatServices(services, async (s) => {
      const { threadId, message, agentId } = (params ?? {}) as { threadId?: string; message?: string; agentId?: string }
      if (!threadId || !message) throw new Error('threadId and message are required')
      const storage = getStorage()
      const conversation = await storage.conversations.getConversation(threadId)
      if (!conversation) throw new Error(`Thread ${threadId} not found`)

      if (activeTurnsByAppServer.has(threadId)) {
        throw new Error(`A turn is already running for thread ${threadId}; call turn/interrupt first.`)
      }

      const targetAgentId = agentId || conversation.agentId
      let agentConfig: AgentConfig | null | undefined = targetAgentId ? await storage.agents.getAgent(targetAgentId) : null
      if (!agentConfig) {
        const agents = await storage.agents.listAgents()
        agentConfig = agents[0] || null
      }
      if (!agentConfig) throw new Error('No agent is configured.')

      const providerId = storage.config.get('activeProviderId')
      const effectiveAgent = resolveEffectiveAgentConfig(agentConfig, {
        providerId,
        model: storage.config.getActiveModel(),
      })
      const provider = s.providerRegistry.get(effectiveAgent.providerId)
      if (!provider) throw new Error(`Provider ${effectiveAgent.providerId} is not available.`)

      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null
      const access = conversation.permissionLevel === 'full-access'
        ? { fileAccessGrants: [] as never[], fullFilesystemAccess: true }
        : conversation.permissionLevel === 'granted-folders'
          ? { fileAccessGrants: conversation.fileAccessGrants || [], fullFilesystemAccess: false }
          : { fileAccessGrants: [], fullFilesystemAccess: false }
      const workspacePath = conversation.workspacePath || storage.config.get('workspacePath') || ''

      const history = sanitizeToolHistory(await storage.conversations.getMessages(threadId))
      const userMessage: ChatMessage = {
        id: uuidv4(),
        conversationId: threadId,
        role: 'user',
        content: message,
        timestamp: Date.now(),
      }
      await storage.conversations.addMessage(threadId, userMessage)

      const storedAutomation = storage.config.get('automation') ?? DEFAULT_AUTOMATION_CONFIG
      const toolApprovalConfig = {
        ...DEFAULT_AUTOMATION_CONFIG.toolApproval,
        ...(storedAutomation as any)?.toolApproval,
      }

      const runner = new AgentRunner({
        conversationId: threadId,
        agentConfig: effectiveAgent,
        provider,
        toolRegistry: s.toolRegistry,
        contextManager: new ContextManager({ environmentRules: storage.config.get('environmentRules') }),
        workspacePath,
        fileAccessGrants: access.fileAccessGrants,
        fullFilesystemAccess: access.fullFilesystemAccess,
        fileService: s.fileService,
        terminalService: s.terminalService,
        modelPools: storage.config.get('modelPools'),
        providerRegistry: s.providerRegistry,
        eventStore: storage.agentRunEvents,
        requestToolApproval: createLocalToolApproval({
          conversationId: threadId,
          workspaceId: conversation.workspaceId,
          window: win,
          config: toolApprovalConfig,
        }),
      })

      hub.broadcast({ topic: 'turn', conversationId: threadId, type: 'turn/started', data: { threadId, message, startedAt: Date.now() }, ts: Date.now() })

      let assistantContent = ''
      const runnerRun = (async () => {
        for await (const event of runner.run({ messages: history, newMessage: userMessage })) {
          if (event.type === 'text' && event.content) {
            assistantContent += event.content
            hub.broadcast({
              topic: 'turn',
              conversationId: threadId,
              type: 'turn/text_delta',
              data: { content: event.content },
              ts: Date.now(),
            })
          } else if (event.type === 'tool_call' && event.toolCall) {
            hub.broadcast({
              topic: 'turn',
              conversationId: threadId,
              type: 'turn/tool_call_start',
              data: { toolCall: event.toolCall },
              ts: Date.now(),
            })
          } else if (event.type === 'tool_result' && event.toolResult) {
            hub.broadcast({
              topic: 'turn',
              conversationId: threadId,
              type: 'turn/tool_result',
              data: {
                toolCallId: event.toolResult.toolCallId,
                toolName: event.toolResult.name,
                result: event.toolResult.result,
                isError: event.toolResult.isError,
              },
              ts: Date.now(),
            })
          } else if (event.type === 'done') {
            return { finishReason: event.finishReason, usage: event.usage }
          } else if (event.type === 'error') {
            throw new Error(event.error || 'Agent failed.')
          }
        }
        return { finishReason: undefined, usage: undefined }
      })()

      const session: TurnSession = {
        conversationId: threadId,
        abort: () => runner.abort(),
        done: runnerRun,
      }
      activeTurnsByAppServer.set(threadId, session)

      // Persist the assistant message when the run completes.
      runnerRun
        .then(async (result) => {
          await storage.conversations.addMessage(threadId, {
            id: uuidv4(),
            conversationId: threadId,
            role: 'assistant',
            content: assistantContent,
            agentId: effectiveAgent.id,
            agentName: effectiveAgent.name,
            timestamp: Date.now(),
          }).catch(() => undefined)
          hub.broadcast({
            topic: 'turn',
            conversationId: threadId,
            type: 'turn/completed',
            data: { threadId, finishReason: result.finishReason, usage: result.usage },
            ts: Date.now(),
          })
          activeTurnsByAppServer.delete(threadId)
        })
        .catch((err) => {
          hub.broadcast({
            topic: 'turn',
            conversationId: threadId,
            type: 'turn/error',
            data: { threadId, message: err?.message ?? String(err) },
            ts: Date.now(),
          })
          activeTurnsByAppServer.delete(threadId)
        })

      return { threadId, startedAt: Date.now(), status: 'running' as const }
    })
  })

  handlers.set(RPC_METHOD.TURN_INTERRUPT, async (params) => {
    const { threadId } = (params ?? {}) as { threadId?: string }
    if (!threadId) throw new Error('threadId is required')
    const session = activeTurnsByAppServer.get(threadId)
    if (!session) return { threadId, interrupted: false, reason: 'no active turn' }
    session.abort()
    rejectAllPendingApprovalsForConversation(threadId, 'Turn was interrupted.')
    activeTurnsByAppServer.delete(threadId)
    return { threadId, interrupted: true }
  })

  handlers.set(RPC_METHOD.APPROVAL_DECIDE, async (params) => {
    const { approvalId, approved, rememberScope } = (params ?? {}) as { approvalId?: string; approved?: boolean; rememberScope?: 'once' | 'session' }
    if (!approvalId) throw new Error('approvalId is required')
    const ok = resolvePendingApproval(approvalId, approved === true, approved ? undefined : 'Denied via app-server.')
    return { ok, approvalId, approved: approved === true, rememberScope: rememberScope || 'once' }
  })

  return handlers
}

function makeErrorEnvelope(req: unknown, code: number, message: string, idOverride?: unknown): RpcErr {
  const id = (req && typeof req === 'object' && 'id' in (req as Record<string, unknown>)) ? (req as RpcRequest).id : idOverride
  return rpcError(id, code, message)
}

// -----------------------------------------------------------------------------
// HTTP server lifecycle
// -----------------------------------------------------------------------------

let serverRef: ReturnType<typeof http.createServer> | null = null
const hub = new SseHub()

export async function startAppServer(chatServices: ChatServices): Promise<ServerStatus> {
  if (serverRef) return { ...status, running: true }
  const bearerToken = randomBytes(24).toString('base64url')
  const deps: ServerDeps = { chatServices, hub, bearerToken }

  // Pull a free port ourselves; do not use port 0 because clients want a stable URL.
  const port = await findFreePort(49152, 60999)

  const handlers = buildMethodHandlers(deps)

  const server = http.createServer(async (req, res) => {
    try {
      setCors(res)
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

      // Health probe (no auth) so external scripts can check reachability.
      if (req.method === 'GET' && req.url === '/health') {
        jsonResponse(res, 200, { ok: true, running: status.running, connections: hub.clientCount() })
        return
      }

      if (!checkAuth(req, bearerToken)) {
        jsonResponse(res, 401, { error: 'Unauthorized' })
        return
      }

      if (req.method === 'GET' && req.url?.startsWith('/v1/events')) {
        const url = new URL(req.url, `http://${req.headers.host}`)
        const conversationId = url.searchParams.get('threadId') || undefined
        const topic = (url.searchParams.get('topic') || undefined) as ServerEvent['topic'] | undefined
        hub.addClient(res, { conversationId, topic })
        status = { ...status, connections: hub.clientCount() }
        return
      }

      if (req.method !== 'POST' || req.url !== '/v1/rpc') {
        jsonResponse(res, 404, { error: 'Not found' })
        return
      }

      let payload: unknown
      try { payload = await readJson(req) } catch (e: any) {
        jsonResponse(res, 400, makeErrorEnvelope({ id: null }, RPC_ERROR.PARSE_ERROR, 'Parse error: ' + (e?.message ?? String(e))))
        return
      }

      if (!isRpcRequest(payload)) {
        jsonResponse(res, 400, makeErrorEnvelope(payload, RPC_ERROR.INVALID_REQUEST, 'Invalid JSON-RPC request envelope.'))
        return
      }

      const { id, method, params } = payload
      const handler = method ? handlers.get(method as RpcMethod) : undefined
      if (!handler) {
        jsonResponse(res, 200, makeErrorEnvelope(payload, RPC_ERROR.METHOD_NOT_FOUND, `Method "${method}" is not supported by this server version.`))
        return
      }

      try {
        const result = await handler(params)
        const ok: RpcEnvelope = { jsonrpc: '2.0', id: (id as RpcEnvelope['id']) ?? null, result }
        jsonResponse(res, 200, ok)
      } catch (e: any) {
        jsonResponse(res, 200, makeErrorEnvelope(payload, RPC_ERROR.INTERNAL_ERROR, e?.message ?? String(e)))
      }
    } catch (e: any) {
      jsonResponse(res, 500, { error: e?.message ?? String(e) })
    }
  })

  server.on('error', (err) => {
    status = { ...status, lastError: err.message }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })

  serverRef = server
  status = {
    ...status,
    running: true,
    host: '127.0.0.1',
    port,
    bearerToken,
    startedAt: Date.now(),
    lastError: null,
    loopbackOnly: true,
    connections: 0,
  }
  return { ...status }
}

export async function stopAppServer(): Promise<ServerStatus> {
  const server = serverRef
  if (!server) return { ...status, running: false }
  serverRef = null
  hub.closeAll()
  for (const session of activeTurnsByAppServer.values()) session.abort()
  activeTurnsByAppServer.clear()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  status = { ...status, running: false, port: null, bearerToken: null, startedAt: null, connections: 0 }
  return { ...status }
}

async function findFreePort(min: number, max: number): Promise<number> {
  // Try a small range; in practice a collision is extremely unlikely on loopback.
  for (let p = min; p <= max; p++) {
    const available = await new Promise<boolean>((resolve) => {
      const tester = http.createServer()
      tester.once('error', () => resolve(false))
      tester.once('listening', () => tester.close(() => resolve(true)))
      tester.listen(p, '127.0.0.1')
    })
    if (available) return p
  }
  throw new Error('No free loopback port available for the app server.')
}
