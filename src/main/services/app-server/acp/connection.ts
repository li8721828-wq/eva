import { randomUUID } from 'crypto'
import { RpcError, type RpcConnection } from '../rpc-connection'
import type { SseHub } from '../sse-hub'
import { EVENT_TYPE, RPC_ERROR_CODE, RPC_METHOD, type RpcMethod, type ServerEvent } from '../protocol'
import { ACP_METHOD, ACP_PROTOCOL_VERSION, ACP_UPDATE, type AcpPermissionResult, type AcpStopReason, type AcpSessionNotification } from './protocol'
import { messageChunk, projectPlan, thoughtChunk, toolCallFinished, toolCallKind, toolCallTitle, toolCallUpdate } from './event-mapping'
import type { ProgressUpdate, ToolApprovalRequest as ToolApprovalCard } from '../../../../shared/types/conversation'
import { rejectAllPendingApprovalsForConversation, resolvePendingApproval, setApprovalRelay, type ApprovalRelay } from '../../tool-approval-policy'

/**
 * The ACP side of one WebSocket connection: the handshake gate, the sessions
 * this connection opened, and the prompt loop that turns Eva's app-server
 * events into `session/update` notifications.
 *
 * Eva's own `thread/*` + `turn/*` handlers do the actual work — this file only
 * translates, so a turn driven from a phone and one driven from the desktop are
 * the same program with the same guards. One prompt per session at a time, which
 * is what ACP assumes.
 *
 * `sessionId` is Eva's `conversationId`. Nothing is stored that
 * `ConversationLifecycleService` does not already own, so a session created here
 * shows up in the desktop list and survives this connection.
 */

interface AcpSession {
  conversationId: string
  /** Set when the client asked to cancel, so the stop reason can be honest. */
  cancelRequested: boolean
}

export interface AcpConnectionDeps {
  connection: RpcConnection
  hub: SseHub
  /** Eva's JSON-RPC methods, shared with the HTTP transport on purpose. */
  callMethod: (method: RpcMethod, params?: unknown) => Promise<unknown>
  /** Reported in `initialize`; passed in because `app.getVersion()` needs a live Electron main process. */
  agentVersion: string
}

export interface AcpConnection {
  register(): void
  /** The socket is going away: stop the work it owned rather than orphan it. */
  dispose(reason: string): void
}

const PERMISSION_OPTIONS = [
  { optionId: 'allow_once', name: '允许本次', kind: 'allow_once' as const },
  { optionId: 'allow_always', name: '本会话内都允许', kind: 'allow_always' as const },
  { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' as const },
]

export function createAcpConnection(deps: AcpConnectionDeps): AcpConnection {
  const { connection, hub } = deps
  const sessions = new Map<string, AcpSession>()
  const cleanups = new Set<() => void>()
  let clientProtocolVersion: number | undefined

  const requireSession = (sessionId: unknown): AcpSession => {
    if (typeof sessionId !== 'string') throw new RpcError('sessionId is required', RPC_ERROR_CODE.INVALID_PARAMS)
    const session = sessions.get(sessionId)
    if (!session) throw new RpcError(`Unknown session: ${sessionId}`, RPC_ERROR_CODE.INVALID_PARAMS)
    return session
  }

  const update = (notification: AcpSessionNotification): void => {
    connection.notify(ACP_METHOD.SESSION_UPDATE, notification)
  }

  /**
   * Ownership of a conversation's approvals for as long as this connection is the
   * one driving it. The session id is bound here rather than looked up later: a
   * prompt on one session must never raise a permission dialog on another.
   *
   * Returning `true` means only "the prompt is on the wire"; the decision comes
   * back through `resolvePendingApproval` with the card's own id, the same door
   * the desktop card uses.
   */
  const createPermissionRelay = (sessionId: string): ApprovalRelay => {
    return (approval: ToolApprovalCard) => {
      if (connection.isClosed) return false
      void connection
        .request<AcpPermissionResult>(ACP_METHOD.SESSION_REQUEST_PERMISSION, {
          sessionId,
          toolCall: { toolCallId: approval.toolCallId, title: approval.summary, kind: toolCallKind(approval.toolName), status: 'pending' },
          options: PERMISSION_OPTIONS,
          _meta: {
            approvalId: approval.id,
            toolName: approval.toolName,
            category: approval.category,
            summary: approval.summary,
            detail: approval.detail,
            arguments: approval.arguments,
          },
        })
        .then((result) => {
          const outcome = result?.outcome
          const optionId = outcome?.outcome === 'selected' ? outcome.optionId : undefined
          const approved = Boolean(optionId?.startsWith('allow'))
          resolvePendingApproval(
            approval.id,
            approved,
            approved ? undefined : '客户端未批准该调用。',
            optionId === 'allow_always' ? 'session' : 'once',
          )
        })
        .catch(() => {
          // A network client never gets a silent pass: an unanswered prompt is a denial.
          resolvePendingApproval(approval.id, false, '客户端未能完成审批，已按拒绝处理。', 'once')
        })
      return true
    }
  }

  const stop = (unsubscribe: () => void): void => {
    cleanups.delete(unsubscribe)
    unsubscribe()
  }

  return {
    register(): void {
      connection.on(ACP_METHOD.INITIALIZE, (params) => {
        const request = (params ?? {}) as { protocolVersion?: number }
        clientProtocolVersion = typeof request.protocolVersion === 'number' ? request.protocolVersion : ACP_PROTOCOL_VERSION
        // The client waits for exactly this result before it considers the agent
        // connected, so the capabilities reported here are what it may call.
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false,
            // Eva reads and writes files and runs commands through its own tools;
            // it never asks the client to do it on its behalf.
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          authMethods: [],
          agentInfo: { name: 'eva', title: 'Eva', version: deps.agentVersion },
        }
      })

      connection.on(ACP_METHOD.SESSION_NEW, async (params) => {
        if (clientProtocolVersion === undefined) throw new RpcError('Call initialize before session/new.', RPC_ERROR_CODE.NOT_INITIALIZED)
        const request = (params ?? {}) as { cwd?: unknown; mcpServers?: unknown }
        if (Array.isArray(request.mcpServers) && request.mcpServers.length > 0) {
          throw new RpcError('Eva 暂不支持客户端提供的 MCP server。', RPC_ERROR_CODE.INVALID_PARAMS)
        }
        const cwd = typeof request.cwd === 'string' && request.cwd.trim() ? request.cwd.trim() : ''
        const thread = await deps.callMethod(RPC_METHOD.THREAD_START, {
          title: 'ACP session',
          ...(cwd ? { workspacePath: cwd } : {}),
          // Never inherit the `full-access` default: this session was opened by a
          // network client, so its reach is the workspace it declared.
          permissionLevel: 'workspace',
        }) as { id?: string }
        if (!thread?.id) throw new RpcError('Eva 未能创建会话。', RPC_ERROR_CODE.INTERNAL_ERROR)
        sessions.set(thread.id, { conversationId: thread.id, cancelRequested: false })
        return { sessionId: thread.id }
      })

      connection.on(ACP_METHOD.SESSION_PROMPT, async (params) => {
        const request = (params ?? {}) as { sessionId?: unknown; prompt?: unknown }
        const session = requireSession(request.sessionId)
        const blocks = Array.isArray(request.prompt) ? (request.prompt as Array<{ type?: string; text?: unknown }>) : []
        const text = blocks
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => String(block.text))
          .join('\n')
          .trim()
        if (!text) throw new RpcError('prompt 需要至少一个 text 内容块。', RPC_ERROR_CODE.INVALID_PARAMS)

        const conversationId = session.conversationId
        const messageId = `msg-${randomUUID()}`
        const progressUpdates: ProgressUpdate[] = []
        setApprovalRelay(conversationId, createPermissionRelay(conversationId))

        try {
          const stopReason = await new Promise<AcpStopReason>((resolve, reject) => {
            let settled = false
            // Subscribe before starting: a turn can raise its first event before
            // `turn/start` resolves, and a missed `turn/error` would hang this prompt.
            const unsubscribe = hub.subscribe(
              (event: ServerEvent) => {
                if (settled) return
                if (event.type === EVENT_TYPE.TURN_TEXT_DELTA) {
                  const content = (event.data as { content?: string }).content
                  if (content) update(messageChunk(conversationId, messageId, content))
                  return
                }
                if (event.type === EVENT_TYPE.TURN_PROGRESS) {
                  const progress = event.data as unknown as ProgressUpdate
                  progressUpdates.push(progress)
                  if (progress.kind === 'plan' || progress.kind === 'step') {
                    update(thoughtChunk(conversationId, progress.content))
                    for (const notification of projectPlan(conversationId, progressUpdates, true)) update(notification)
                  } else {
                    update(thoughtChunk(conversationId, progress.content))
                  }
                  return
                }
                if (event.type === EVENT_TYPE.TURN_TOOL_CALL_START) {
                  const call = (event.data as { toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown> } }).toolCall
                  if (call?.id) update(toolCallUpdate(conversationId, call.id, toolCallTitle(call.name || 'tool', call.arguments), call.name || 'tool'))
                  return
                }
                if (event.type === EVENT_TYPE.TURN_TOOL_RESULT) {
                  const result = event.data as { toolCallId?: string; isError?: boolean }
                  if (result.toolCallId) update(toolCallFinished(conversationId, result.toolCallId, Boolean(result.isError)))
                  return
                }
                if (event.type === EVENT_TYPE.TURN_COMPLETED) {
                  settled = true
                  stop(unsubscribe)
                  resolve(session.cancelRequested ? 'cancelled' : 'end_turn')
                  return
                }
                if (event.type === EVENT_TYPE.TURN_ERROR) {
                  settled = true
                  stop(unsubscribe)
                  reject(new RpcError(String((event.data as { message?: string }).message || 'Eva 本轮执行失败。'), RPC_ERROR_CODE.INTERNAL_ERROR))
                }
              },
              { conversationId, topic: 'turn' },
            )
            cleanups.add(unsubscribe)

            deps
              .callMethod(RPC_METHOD.TURN_START, { threadId: conversationId, message: text })
              .catch((e: any) => {
                if (settled) return
                settled = true
                stop(unsubscribe)
                reject(new RpcError(e?.message ?? String(e), RPC_ERROR_CODE.INVALID_REQUEST))
              })
          })

          // One last snapshot with the streaming marker cleared, so the client's
          // checklist ends on the truth rather than on the last intermediate state.
          // Only the checklist: the overflow note already travelled with each step.
          for (const notification of projectPlan(conversationId, progressUpdates, false)) {
            if (notification.update.sessionUpdate === ACP_UPDATE.PLAN) update(notification)
          }
          return { stopReason }
        } catch (e) {
          // ACP has no error notification: say what failed in the chat stream too,
          // then answer the prompt request with the error.
          const message = e instanceof Error ? e.message : String(e)
          update(messageChunk(conversationId, messageId, `\n[本轮失败] ${message}`))
          throw e
        } finally {
          setApprovalRelay(conversationId, null)
        }
      })

      connection.on(ACP_METHOD.SESSION_CANCEL, (params) => {
        const request = (params ?? {}) as { sessionId?: unknown }
        if (typeof request.sessionId !== 'string') return
        const session = sessions.get(request.sessionId)
        if (!session) return
        session.cancelRequested = true
        void deps.callMethod(RPC_METHOD.TURN_INTERRUPT, { threadId: session.conversationId })
      })
    },

    dispose(reason: string): void {
      for (const session of sessions.values()) {
        setApprovalRelay(session.conversationId, null)
        // Nobody is left on this socket to answer an open dialog; leaving those
        // pending would hold the runner until its own timeout fires.
        rejectAllPendingApprovalsForConversation(session.conversationId, `ACP 连接已断开（${reason}），未完成审批按拒绝处理。`)
        if (session.cancelRequested) continue
        session.cancelRequested = true
        void deps.callMethod(RPC_METHOD.TURN_INTERRUPT, { threadId: session.conversationId })
      }
      for (const cleanup of cleanups) cleanup()
      cleanups.clear()
      sessions.clear()
      clientProtocolVersion = undefined
    },
  }
}
