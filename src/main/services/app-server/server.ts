import http, { type IncomingMessage, type ServerResponse } from 'http'
import https from 'https'
import { randomBytes } from 'crypto'
import { SseHub } from './sse-hub'
import type { ChatServices } from '../../ipc/conversation'
import { RPC_ERROR_CODE as RPC_ERROR, RPC_METHOD, type RpcEnvelope, type RpcErr, type RpcMethod, type RpcMethodHandler, type ServerEvent, type ServerStatus } from './protocol'
import { getStorage } from '../../storage'
import { app, BrowserWindow } from 'electron'
import { ACP_PATH, registerAcpUpgrade, type AcpGateway } from './acp'
import { activeRunRegistry } from '../run-registry'
import { AgentRunner } from '../../agent-engine/agent-runner'
import { ContextManager } from '../../agent-engine/context'
import { v4 as uuidv4 } from 'uuid'
import { sanitizeToolHistory } from '../../agent-engine/tool-history'
import { resolveEffectiveAgentConfig } from '../effective-agent-config'
import { createLocalToolApproval, rejectAllPendingApprovalsForConversation, resolvePendingApproval } from '../tool-approval-policy'
import { DEFAULT_AUTOMATION_CONFIG } from '../../../shared/types/automation'
import { recordActivity } from '../activity-log'
import { notifyRendererConversationChanged } from '../conversation-notify'
import type { AgentConfig } from '../../../shared/types/agent'
import type { ChatMessage, ChatUsage, ConversationPermissionLevel, ProgressUpdate, ProgressUpdateKind, ResponseTiming, ToolCall } from '../../../shared/types/conversation'
import { TurnProgressProjector, stripProgressBlocks, toProgressSummaries, unwrapProgressTags } from '../../ipc/progress-protocol'
import { toPublicExecutionNote } from '../../ipc/public-execution-trace'
import { ConversationLifecycleService } from '../conversation-lifecycle-service'
import { isLoopbackHost, normalizeListenHost, readRequiredPem, resolveBaseUrl, validateRemoteTransport } from './transport'

// -----------------------------------------------------------------------------
// ServerStatus singleton holds the runtime state of the HTTP server.
// -----------------------------------------------------------------------------

let status: ServerStatus = {
  running: false,
  host: '127.0.0.1',
  port: null,
  scheme: 'http',
  baseUrl: null,
  rpcUrl: null,
  acpUrl: null,
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

/**
 * Conversations created over a network door are bounded to their workspace.
 * `ConversationLifecycleService` defaults to `full-access` when no workspace is
 * attached, which suits a window the user is looking at but must not be
 * reachable by a params object — so the default is applied on this side.
 */
function networkPermissionLevel(level: ConversationPermissionLevel | undefined): ConversationPermissionLevel {
  return level === 'granted-folders' ? 'granted-folders' : 'workspace'
}

/**
 * Free the conversation's `chat` slot for a turn that started here. Only when the
 * handle is still ours: a desktop send takes the slot over (abort + set) long
 * before this turn unwinds, and clearing that would leave the desktop run unnamed.
 */
function releaseChatRunOwnership(runner: AgentRunner, conversationId: string): void {
  if (activeChatRunners.get(conversationId) === runner) activeChatRunners.delete(conversationId)
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
  done: Promise<{ finishReason?: string; usage?: ChatUsage; timing?: ResponseTiming }>
}

const activeTurnsByAppServer = new Map<string, TurnSession>()

/** One ownership slot per conversation, shared with the desktop chat runs: whoever
 *  holds it is the runner that `CHAT_ABORT` stops and that a second `turn/start`
 *  has to refuse. */
const activeChatRunners = activeRunRegistry.forKind<AgentRunner>('chat')

function buildMethodHandlers(deps: ServerDeps): Map<RpcMethod, RpcMethodHandler> {
  const { chatServices: services, hub } = deps

  const handlers = new Map<RpcMethod, RpcMethodHandler>()

  handlers.set(RPC_METHOD.SERVER_STATUS, async () => ({
    ...status,
    connections: hub.clientCount(),
    acp: status.acp ? { ...status.acp, connections: acpGateway?.connections() ?? 0 } : undefined,
  }))

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
      const { agentId, title, workspaceId, workspacePath, permissionLevel } = (params ?? {}) as {
        agentId?: string
        title?: string
        workspaceId?: string
        workspacePath?: string
        permissionLevel?: ConversationPermissionLevel
      }
      const lifecycle = new ConversationLifecycleService(s.storage)
      const conversation = await lifecycle.create({
        title: title || 'App-Server thread',
        agentId,
        workspaceId,
        workspacePath,
        permissionLevel: networkPermissionLevel(permissionLevel),
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
      // The registry is the one place that knows who owns a conversation's run, so
      // this refuses both a desktop turn in flight and another app-server turn —
      // two runners over one history would interleave their messages and compete
      // for the same approval card.
      if (activeChatRunners.has(threadId)) {
        throw new Error(`Thread ${threadId} is already running a turn; stop it before starting another one.`)
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

      // Same recent-window rule the desktop chat run uses; sending a long
      // conversation in full made a remotely driven turn cost differently.
      const history = sanitizeToolHistory(await storage.conversations.getRecentMessages(threadId, 80))
      const userMessage: ChatMessage = {
        id: uuidv4(),
        conversationId: threadId,
        role: 'user',
        content: message,
        timestamp: Date.now(),
      }
      await storage.conversations.addMessage(threadId, userMessage)
      // External clients drive this turn; the desktop windows still have to see
      // the new request and the reply that follows.
      notifyRendererConversationChanged(threadId)
      const durableMemory = await storage.longTermMemory.buildContext('default', {
        workspaceId: conversation.workspaceId,
        workspacePath,
      }, message, 12, { enabled: storage.personalPreferences.getSettings().injectionEnabled })

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
        contextManager: new ContextManager({ durableMemory, environmentRules: storage.config.get('environmentRules') }),
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
          onRequested: (approval) => hub.broadcast({
            topic: 'turn',
            conversationId: threadId,
            type: 'turn/approval_request',
            data: { approval: approval as unknown as Record<string, unknown> },
            ts: Date.now(),
          }),
        }),
      })
      // Owned by the shared registry the moment it exists, on the same synchronous
      // stretch the desktop send uses: a turn driven from a phone then holds `chat`
      // for this conversation exactly like a desktop run, so the window can stop it
      // and neither transport can quietly build a second runner over one history.
      activeChatRunners.set(threadId, runner)

      hub.broadcast({ topic: 'turn', conversationId: threadId, type: 'turn/started', data: { threadId, message, startedAt: Date.now() }, ts: Date.now() })

      let assistantContent = ''
      const progressProjector = new TurnProgressProjector()
      const progressUpdates: ProgressUpdate[] = []
      const toolCalls: ToolCall[] = []
      const toolResults: { toolCallId: string; name: string; result: string; isError?: boolean; protocol?: ToolCall['protocol'] }[] = []
      const processOutput = effectiveAgent.processOutput || (effectiveAgent.showThinking ? 'detailed' : 'compact')
      let lastPublicExecutionNote = ''
      let latestProgressContent = ''

      const emitProgress = async (kind: ProgressUpdateKind, content: string, item?: number): Promise<void> => {
        for (const summary of toProgressSummaries(kind, content)) {
          if (!summary || summary === latestProgressContent) continue
          latestProgressContent = summary
          const progress: ProgressUpdate = {
            id: uuidv4(),
            kind,
            content: summary,
            ...(item ? { item } : {}),
            timestamp: Date.now(),
          }
          progressUpdates.push(progress)
          // Persisted as its own row exactly like the desktop run does, so a
          // refresh after a remotely driven turn still rebuilds the checklist.
          await storage.conversations.addMessage(threadId, {
            id: progress.id,
            conversationId: threadId,
            role: 'assistant',
            content: summary,
            progressKind: kind,
            ...(item ? { progressItem: item } : {}),
            agentId: effectiveAgent.id,
            agentName: effectiveAgent.name,
            timestamp: progress.timestamp,
          }).catch(() => undefined)
          hub.broadcast({
            topic: 'turn',
            conversationId: threadId,
            type: 'turn/progress',
            data: progress as unknown as Record<string, unknown>,
            ts: progress.timestamp,
          })
        }
      }

      const runnerRun = (async () => {
        for await (const event of runner.run({ messages: history, newMessage: userMessage })) {
          if (event.type === 'text' && event.content) {
            for (const segment of progressProjector.feed(event.content)) {
              if (segment.type === 'progress') {
                await emitProgress(segment.kind, segment.content, segment.item)
                continue
              }
              assistantContent += segment.content
              hub.broadcast({
                topic: 'turn',
                conversationId: threadId,
                type: 'turn/text_delta',
                data: { content: segment.content },
                ts: Date.now(),
              })
            }
          } else if (event.type === 'text_reset') {
            progressProjector.discardPending()
          } else if (event.type === 'thinking') {
            // The app-server/ACP path has no renderer timeline. Reuse the same
            // allow-listed public vocabulary as desktop chat, while keeping
            // raw model/provider thinking out of the network stream.
            if (processOutput !== 'off') {
              const publicNote = toPublicExecutionNote(event.content, toolResults.length > 0)
              if (publicNote && publicNote !== lastPublicExecutionNote) {
                lastPublicExecutionNote = publicNote
                await emitProgress('thinking', publicNote)
              }
            }
          } else if (event.type === 'tool_call' && event.toolCall) {
            progressProjector.discardPending()
            toolCalls.push({ id: event.toolCall.id, name: event.toolCall.name, arguments: { ...event.toolCall.arguments } })
            hub.broadcast({
              topic: 'turn',
              conversationId: threadId,
              type: 'turn/tool_call_start',
              data: { toolCall: event.toolCall },
              ts: Date.now(),
            })
          } else if (event.type === 'tool_result' && event.toolResult) {
            progressProjector.discardPending()
            toolResults.push(event.toolResult)
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
            progressProjector.discardPending()
            if (event.content) {
              const stripped = stripProgressBlocks(event.content).trim()
              assistantContent = stripped || unwrapProgressTags(event.content).trim()
            }
            return { finishReason: event.finishReason, usage: event.usage, timing: event.timing }
          } else if (event.type === 'error') {
            throw new Error(event.error || 'Agent failed.')
          }
        }
        return { finishReason: undefined, usage: undefined, timing: undefined }
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
          const assistantMessageId = uuidv4()
          await storage.conversations.addMessage(threadId, {
            id: assistantMessageId,
            conversationId: threadId,
            role: 'assistant',
            content: assistantContent,
            progressUpdates: progressUpdates.length > 0 ? progressUpdates : undefined,
            toolCalls: toolCalls.length > 0
              ? toolCalls.map((call) => {
                  const completed = toolResults.find((candidate) => candidate.toolCallId === call.id)
                  return completed
                    ? { ...call, result: completed.result, isError: completed.isError, protocol: completed.protocol }
                    : call
                })
              : undefined,
            agentId: effectiveAgent.id,
            agentName: effectiveAgent.name,
            providerId: effectiveAgent.providerId,
            providerName: storage.config.getProvider(effectiveAgent.providerId)?.name || effectiveAgent.providerId,
            model: effectiveAgent.model,
            usage: result.usage,
            timing: result.timing,
            finishReason: result.finishReason,
            timestamp: Date.now(),
          }).catch(() => undefined)
          notifyRendererConversationChanged(threadId)
          s.memoryAgent.enqueue({
            conversationId: threadId,
            messageId: assistantMessageId,
            workspaceId: conversation.workspaceId,
            workspacePath,
            userRequest: message,
            assistantResult: assistantContent,
            status: 'completed',
          }, effectiveAgent.providerId, effectiveAgent.model)
          hub.broadcast({
            topic: 'turn',
            conversationId: threadId,
            type: 'turn/completed',
            data: { threadId, finishReason: result.finishReason, usage: result.usage },
            ts: Date.now(),
          })
          activeTurnsByAppServer.delete(threadId)
          releaseChatRunOwnership(runner, threadId)
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
          releaseChatRunOwnership(runner, threadId)
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
    const scope = rememberScope === 'session' ? 'session' : 'once'
    const ok = resolvePendingApproval(approvalId, approved === true, approved ? undefined : 'Denied via app-server.', scope)
    return { ok, approvalId, approved: approved === true, rememberScope: scope }
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

let serverRef: http.Server | null = null
let acpGateway: AcpGateway | null = null
const hub = new SseHub()

export interface AppServerStartOptions {
  /** Port to try before falling back to a free one. Remote clients also benefit from a stable port. */
  preferredPort?: number | null
  /** Interface/address to bind. Non-loopback values require the remote HTTPS profile. */
  listenHost?: string
  /** Public HTTPS origin used by remote clients, without the `/acp` suffix. */
  publicBaseUrl?: string
  /** PEM files required when `listenHost` is not loopback. */
  tlsCertPath?: string
  tlsKeyPath?: string
  /** Defaults to `true`; remote mode always overrides this to true. */
  acpRequireAuth?: boolean
}

export async function startAppServer(chatServices: ChatServices, options: AppServerStartOptions = {}): Promise<ServerStatus> {
  if (serverRef) return { ...status, running: true }
  const bearerToken = randomBytes(24).toString('base64url')
  const listenHost = normalizeListenHost(options.listenHost)
  const loopbackOnly = isLoopbackHost(listenHost)
  const hasPublicBaseUrl = Boolean(options.publicBaseUrl?.trim())
  const acpRequireAuth = (!loopbackOnly || hasPublicBaseUrl) ? true : options.acpRequireAuth !== false
  const scheme = loopbackOnly ? 'http' : 'https'
  validateRemoteTransport({ loopbackOnly, publicBaseUrl: options.publicBaseUrl, tlsCertPath: options.tlsCertPath, tlsKeyPath: options.tlsKeyPath })
  const deps: ServerDeps = { chatServices, hub, bearerToken }

  // A fixed port first, then any free one: remote clients and port forwarding
  // cannot follow a port that changes on every start.
  const port = await resolveListenPort(options.preferredPort, listenHost)
  const resolvedBaseUrl = resolveBaseUrl({
    scheme,
    host: listenHost,
    port,
    publicBaseUrl: options.publicBaseUrl,
    loopbackOnly,
  })
  const advertisedScheme = new URL(resolvedBaseUrl).protocol === 'https:' ? 'wss' : 'ws'

  const handlers = buildMethodHandlers(deps)

  const requestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      setCors(res)
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

      // Keep the local health probe convenient, but do not expose remote
      // runtime information without the same bearer token as the RPC door.
      if (req.method === 'GET' && req.url === '/health') {
        if (!loopbackOnly && !checkAuth(req, bearerToken)) {
          jsonResponse(res, 401, { error: 'Unauthorized' })
          return
        }
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
  }

  const server = loopbackOnly
    ? http.createServer(requestHandler)
    : https.createServer({
      cert: readRequiredPem(options.tlsCertPath, '证书'),
      key: readRequiredPem(options.tlsKeyPath, '私钥'),
    }, requestHandler)

  server.on('error', (err) => {
    status = { ...status, lastError: err.message }
  })

  acpGateway = registerAcpUpgrade(server, {
    hub,
    callMethod: (method, params) => {
      const handler = handlers.get(method)
      if (!handler) throw new Error(`Method "${method}" is not supported by this server version.`)
      return Promise.resolve(handler(params))
    },
    bearerToken,
    requireAuth: acpRequireAuth,
    agentVersion: app.getVersion(),
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, listenHost, () => resolve())
  })

  serverRef = server
  status = {
    ...status,
    running: true,
    host: listenHost,
    port,
    scheme,
    baseUrl: resolvedBaseUrl,
    rpcUrl: `${resolvedBaseUrl}/v1/rpc`,
    acpUrl: `${advertisedScheme}://${resolvedBaseUrl.slice(resolvedBaseUrl.indexOf('://') + 3)}${ACP_PATH}`,
    bearerToken,
    startedAt: Date.now(),
    lastError: null,
    loopbackOnly,
    connections: 0,
    acp: { enabled: true, path: ACP_PATH, requireAuth: acpRequireAuth, connections: 0 },
  }
  return { ...status }
}

export async function stopAppServer(): Promise<ServerStatus> {
  const server = serverRef
  if (!server) return { ...status, running: false }
  serverRef = null
  acpGateway?.close()
  acpGateway = null
  hub.closeAll()
  for (const session of activeTurnsByAppServer.values()) session.abort()
  activeTurnsByAppServer.clear()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  status = {
    ...status,
    running: false,
    port: null,
    baseUrl: null,
    rpcUrl: null,
    acpUrl: null,
    bearerToken: null,
    startedAt: null,
    connections: 0,
    acp: undefined,
  }
  return { ...status }
}

/**
 * The configured port wins when it is free, because remote clients and reverse
 * proxies need a stable endpoint. A busy or nonsensical preference falls back
 * to the scan.
 */
async function resolveListenPort(preferredPort: number | null | undefined, host: string): Promise<number> {
  if (typeof preferredPort === 'number' && Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535) {
    if (await isPortFree(preferredPort, host)) return preferredPort
  }
  return findFreePort(49152, 60999, host)
}

async function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const tester = http.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => tester.close(() => resolve(true)))
    tester.listen(port, host)
  })
}

async function findFreePort(min: number, max: number, host: string): Promise<number> {
  // Try a small range; a collision is unlikely, but the check uses the same
  // interface as the real server so a public listener cannot steal a port that
  // is only free on loopback.
  for (let p = min; p <= max; p++) {
    if (await isPortFree(p, host)) return p
  }
  throw new Error('没有可用的 App Server 端口。')
}
