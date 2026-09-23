import { BrowserWindow } from 'electron'
import type { ToolApprovalDecision, ToolApprovalRequest } from '../agent-engine/agent-runner'
import type { ToolApprovalRequest as ToolApprovalCard } from '../../shared/types/conversation'
import type { ToolApprovalConfig, ToolApprovalPolicy } from '../../shared/types/automation'
import { IPC } from '../../shared/ipc-channels'
import { v4 as uuidv4 } from 'uuid'
import { recordActivity } from './activity-log'

// -----------------------------------------------------------------------------
// Tool classification: which tools need approval, at which policy level.
// Mirrors the read/write sets used inside agent-runner.ts, but this list is the
// broader one: every registered tool name must appear here under its real name,
// otherwise it silently falls through to "no approval".
// -----------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'search_code',
  'search_by_regex',
  'file_info',
  'web_search',
  'read_web_page',
  'read_terminal',
  'project_search',
  'project_index_status',
  'inspect_runtime',
  'diagnose_runtime',
  'delegate_to_team',
  'delegate_to_model_pool',
  'run_task',
  'run_goal',
  'manage_goal',
  'create_execution_plan',
  'apply_spec_template',
])

const WORKSPACE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'spreadsheet',
])

const TERMINAL_COMMAND_TOOLS = new Set([
  'execute_command',
  'write_terminal',
])

const BROWSER_CONTROL_TOOLS = new Set([
  'browser_control',
])

export type ApprovalCategory =
  | 'workspace-write'
  | 'terminal-command'
  | 'mcp-call'
  | 'browser-control'
  | 'other'

function classifyToolName(name: string): ApprovalCategory {
  if (name.startsWith('mcp__')) return 'mcp-call'
  if (WORKSPACE_WRITE_TOOLS.has(name)) return 'workspace-write'
  if (TERMINAL_COMMAND_TOOLS.has(name)) return 'terminal-command'
  if (BROWSER_CONTROL_TOOLS.has(name)) return 'browser-control'
  return 'other'
}

/**
 * Decide whether a given tool call needs explicit human approval under the
 * supplied policy. Returns `null` when the call should run unattended.
 */
export function requiresApproval(
  toolName: string,
  policy: ToolApprovalPolicy,
): ApprovalCategory | null {
  switch (policy) {
    case 'off':
      return null
    case 'paranoid':
      return classifyToolName(toolName)
    case 'strict':
      if (READ_ONLY_TOOLS.has(toolName)) return null
      return classifyToolName(toolName)
    case 'safe':
      if (READ_ONLY_TOOLS.has(toolName)) return null
      if (
        WORKSPACE_WRITE_TOOLS.has(toolName)
        || TERMINAL_COMMAND_TOOLS.has(toolName)
        || BROWSER_CONTROL_TOOLS.has(toolName)
        || toolName.startsWith('mcp__')
      ) {
        return classifyToolName(toolName)
      }
      // Read_terminal + spreadsheet read paths fall through to "no approval".
      return null
  }
}

function buildSummary(toolName: string, args: Record<string, unknown>, category: ApprovalCategory): { summary: string; detail?: string } {
  if (category === 'workspace-write' && (toolName === 'write_file' || toolName === 'edit_file')) {
    const target = String(args.path || '(missing path)')
    return { summary: `${toolName === 'write_file' ? 'Write' : 'Edit'} ${target}`, detail: `Workspace: ${args.workspacePath || '(default)'}` }
  }
  if (category === 'terminal-command') {
    const command = String(args.command || args.text || '(missing command)')
    const preview = command.length > 200 ? `${command.slice(0, 200)}…` : command
    return { summary: `Run command in terminal`, detail: preview }
  }
  if (category === 'mcp-call') {
    const server = toolName.split('__')[1] || '?'
    const action = toolName.split('__').slice(2).join('__') || toolName
    return { summary: `MCP tool: ${server}/${action}`, detail: JSON.stringify(args).slice(0, 400) }
  }
  if (category === 'browser-control') {
    const action = typeof args.action === 'string' ? args.action : 'control'
    return { summary: `Browser: ${action}`, detail: JSON.stringify(args).slice(0, 200) }
  }
  return { summary: `Tool: ${toolName}`, detail: JSON.stringify(args).slice(0, 200) }
}

// -----------------------------------------------------------------------------
// Pending approval registry: tracks in-flight approval requests keyed by ID so
// the AgentRunner promise can be resolved by an IPC handler from the renderer.
// -----------------------------------------------------------------------------

interface PendingApproval {
  conversationId: string
  toolName: string
  category: ApprovalCategory
  resolve: (decision: ToolApprovalDecision) => void
  timer: NodeJS.Timeout
}

const pendingApprovals = new Map<string, PendingApproval>()

// -----------------------------------------------------------------------------
// Session-scoped approvals: the card offers "allow for this session" beside
// "allow once". A session grant is remembered per conversation and per category,
// which is the scope the card actually shows the user (its category chip), so an
// accepted grant stops the same kind of operation from asking again in that
// conversation. The registry is in-memory: a "session" ends with the process or
// when the conversation itself is deleted.
// -----------------------------------------------------------------------------

const sessionApprovals = new Map<string, Set<ApprovalCategory>>()

function grantCategoryForSession(conversationId: string, category: ApprovalCategory): void {
  const granted = sessionApprovals.get(conversationId)
  if (granted) granted.add(category)
  else sessionApprovals.set(conversationId, new Set([category]))
}

function hasSessionGrant(conversationId: string, category: ApprovalCategory): boolean {
  return sessionApprovals.get(conversationId)?.has(category) === true
}

export function clearSessionApprovals(conversationId: string): void {
  sessionApprovals.delete(conversationId)
}

/**
 * One approval card is visible per conversation, so a request that arrives while
 * another is on screen waits its turn. A parallel tool batch (paranoid mode asks
 * for every tool) would otherwise replace the visible card and auto-deny every
 * sibling that never got shown.
 */
const approvalWaiters = new Map<string, ApprovalWaiter[]>()
const displayedApprovals = new Set<string>()

interface ApprovalWaiter {
  conversationId: string
  deliver: () => void
  deny: (reason: string) => void
}

const APPROVAL_DEFAULTS_DENIED_MESSAGE = 'Approval window expired before a decision was made.'

/** Show the request, or queue it behind the card the user is already looking at. */
function presentApproval(waiter: ApprovalWaiter): void {
  if (displayedApprovals.has(waiter.conversationId)) {
    const waiting = approvalWaiters.get(waiter.conversationId) ?? []
    waiting.push(waiter)
    approvalWaiters.set(waiter.conversationId, waiting)
    return
  }
  displayedApprovals.add(waiter.conversationId)
  waiter.deliver()
}

/** The visible card was decided: hand the slot to the next waiting request. */
function releaseApprovalSlot(conversationId: string): void {
  const waiting = approvalWaiters.get(conversationId)
  const next = waiting?.shift()
  if (next) {
    next.deliver()
    return
  }
  if (waiting) approvalWaiters.delete(conversationId)
  displayedApprovals.delete(conversationId)
}

function rejectAllForConversation(conversationId: string, reason: string): void {
  const waiting = approvalWaiters.get(conversationId)
  approvalWaiters.delete(conversationId)
  displayedApprovals.delete(conversationId)
  for (const waiter of waiting ?? []) waiter.deny(reason)
  for (const [approvalId, pending] of pendingApprovals) {
    if (pending.conversationId !== conversationId) continue
    clearTimeout(pending.timer)
    pendingApprovals.delete(approvalId)
    pending.resolve({ approved: false, message: reason })
  }
}

export function rejectAllPendingApprovalsForConversation(conversationId: string, reason: string): void {
  rejectAllForConversation(conversationId, reason)
}

export function resolvePendingApproval(
  approvalId: string,
  approved: boolean,
  message?: string,
  rememberScope?: 'once' | 'session',
): boolean {
  const pending = pendingApprovals.get(approvalId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingApprovals.delete(approvalId)
  if (approved && rememberScope === 'session') {
    grantCategoryForSession(pending.conversationId, pending.category)
  }
  pending.resolve(approved
    ? { approved: true }
    : { approved: false, message: message || 'The user denied the request.' })
  return true
}

// -----------------------------------------------------------------------------
// Approval factory: returns an `AgentRunnerConfig.requestToolApproval` callback
// that emits a stream event to the renderer and waits for the decision.
// -----------------------------------------------------------------------------

export interface ApprovalFactoryContext {
  conversationId: string
  workspaceId?: string
  /** The desktop window the stream runs through. A relay registered for this
   *  conversation (see `setApprovalRelay`) takes the card first; this is the
   *  fallback. When both are absent the policy falls back to `headlessMode`. */
  window: BrowserWindow | null
  config: ToolApprovalConfig
  /** Called with the card as soon as it exists, wherever it is ultimately shown. */
  onRequested?: (approval: ToolApprovalCard) => void
  /**
   * What to do when no window and no relay can receive the card: `auto-approve`
   * (the default when the policy is `off`), or `deny` (the default otherwise).
   */
  headlessMode?: 'auto-approve' | 'deny'
}

/**
 * A transport that has no `BrowserWindow` takes ownership of one conversation's
 * approvals for as long as it drives that conversation. The relay returns
 * `false` when the card could not be handed over, which denies the call on the
 * spot; the answer arrives later through `resolvePendingApproval` with the
 * card's id, exactly as the renderer delivers one.
 */
export type ApprovalRelay = (approval: ToolApprovalCard) => boolean

const approvalRelays = new Map<string, ApprovalRelay>()

export function setApprovalRelay(conversationId: string, relay: ApprovalRelay | null): void {
  if (relay) approvalRelays.set(conversationId, relay)
  else approvalRelays.delete(conversationId)
}

export function createLocalToolApproval(context: ApprovalFactoryContext): (request: ToolApprovalRequest) => Promise<ToolApprovalDecision> {
  const { conversationId, workspaceId, window, config } = context

  return async (request: ToolApprovalRequest) => {
    const category = requiresApproval(request.toolCall.name, config.policy)
    if (category === null) {
      return { approved: true }
    }

    // Earlier in this session the user asked not to be prompted again for this
    // category in this conversation, and that decision still holds.
    if (hasSessionGrant(conversationId, category)) {
      return { approved: true }
    }

    const approvalId = uuidv4()
    const { summary, detail } = buildSummary(request.toolCall.name, request.toolCall.arguments, category)
    const approvalPayload: ToolApprovalCard = {
      id: approvalId,
      toolCallId: request.toolCall.id,
      toolName: request.toolCall.name,
      arguments: request.toolCall.arguments,
      workspacePath: request.workspacePath,
      category,
      summary,
      detail,
      requestedAt: Date.now(),
    }

    void recordActivity({
      category: 'permission',
      action: 'chat.tool_approval_requested',
      status: 'info',
      summary: `Asking for approval: ${request.toolCall.name}.`,
      conversationId,
      workspaceId,
    })

    // One owner for "where does this card go". An injected transport (the ACP
    // WebSocket) wins; otherwise the desktop window, checked per call because it
    // can be closed while the run is still going.
    const deliverCard: ((approval: ToolApprovalCard) => boolean) | null = approvalRelays.get(conversationId)
      ?? (window
        ? (approval) => {
            if (window.isDestroyed()) return false
            window.webContents.send(IPC.CHAT_STREAM, {
              conversationId,
              type: 'tool_approval_request',
              toolApproval: approval,
            })
            return true
          }
        : null)

    // Nothing to ask: fall back to a static mode.
    if (!deliverCard) {
      const headlessMode = context.headlessMode ?? (config.policy === 'off' ? 'auto-approve' : 'deny')
      if (headlessMode === 'auto-approve') return { approved: true }
      return { approved: false, message: 'No renderer available to approve this tool call; denied by policy.' }
    }

    return new Promise<ToolApprovalDecision>((resolve) => {
      const settle = (decision: ToolApprovalDecision): void => {
        releaseApprovalSlot(conversationId)
        resolve(decision)
      }

      const deliver = (): void => {
        // Registered before the card leaves: a client can answer as soon as it
        // receives it, and that answer has to find something to resolve.
        const timer = setTimeout(() => {
          if (!pendingApprovals.has(approvalId)) return
          pendingApprovals.delete(approvalId)
          void recordActivity({
            category: 'permission',
            action: 'chat.tool_approval_timeout',
            status: 'error',
            summary: `Approval timed out: ${request.toolCall.name}.`,
            conversationId,
            workspaceId,
          })
          settle({
            approved: false,
            message: `Approval timed out after ${Math.round(config.timeoutMs / 1000)}s. The tool call was denied.`,
          })
        }, config.timeoutMs)
        pendingApprovals.set(approvalId, {
          conversationId,
          toolName: request.toolCall.name,
          category,
          resolve: settle,
          timer,
        })
        // Announced only now: before this moment the id does not resolve, and an
        // observer that answered straight away would have its decision dropped.
        context.onRequested?.(approvalPayload)

        if (!deliverCard(approvalPayload)) {
          clearTimeout(timer)
          pendingApprovals.delete(approvalId)
          settle({ approved: false, message: '审批卡片无法送达该客户端，本次调用已按拒绝处理。' })
        }
      }

      presentApproval({
        conversationId,
        deliver,
        deny: (reason) => resolve({ approved: false, message: reason }),
      })
    })
  }
}
