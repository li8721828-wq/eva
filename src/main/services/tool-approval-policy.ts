import { BrowserWindow } from 'electron'
import type { ToolApprovalDecision, ToolApprovalRequest } from '../agent-engine/agent-runner'
import type { ToolApprovalConfig, ToolApprovalPolicy } from '../../shared/types/automation'
import { IPC } from '../../shared/ipc-channels'
import { v4 as uuidv4 } from 'uuid'
import { recordActivity } from './activity-log'

// -----------------------------------------------------------------------------
// Tool classification: which tools need approval, at which policy level.
// Mirrors `PARALLEL_SAFE_READ_TOOL_NAMES` and `WORKSPACE_MUTATION_TOOL_NAMES`
// defined inside agent-runner.ts, but exposed here so the policy logic does
// not need to import a private constant. Keep both lists in sync.
// -----------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'web_search',
  'read_web_page',
  'read_terminal',
  'project_search',
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
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_evaluate',
  'close_browser',
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
    return { summary: `Browser: ${toolName}`, detail: JSON.stringify(args).slice(0, 200) }
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
  resolve: (decision: ToolApprovalDecision) => void
  timer: NodeJS.Timeout
}

const pendingApprovals = new Map<string, PendingApproval>()

const APPROVAL_DEFAULTS_DENIED_MESSAGE = 'Approval window expired before a decision was made.'

function rejectAllForConversation(conversationId: string, reason: string): void {
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

export function resolvePendingApproval(approvalId: string, approved: boolean, message?: string): boolean {
  const pending = pendingApprovals.get(approvalId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingApprovals.delete(approvalId)
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
  /** The browser window the stream runs through. `null` means no renderer is
   *  available (e.g. external app-server client). The policy will then fall
   *  back to a tool-by-tool allow/deny based on `mode`. */
  window: BrowserWindow | null
  config: ToolApprovalConfig
  /**
   * When the window is null, what should we do? `auto-approve` (default for
   * app-server clients that talk to operators who set them up), `deny`, or
   * `delegate-to-approval-request` (recommended for live streaming to a
   * remote renderer via `EVA_APPROVAL_BRIDGE_HOST`).
   */
  headlessMode?: 'auto-approve' | 'deny'
}

export function createLocalToolApproval(context: ApprovalFactoryContext): (request: ToolApprovalRequest) => Promise<ToolApprovalDecision> {
  const { conversationId, workspaceId, window, config } = context

  return async (request: ToolApprovalRequest) => {
    const category = requiresApproval(request.toolCall.name, config.policy)
    if (category === null) {
      return { approved: true }
    }

    // A newer request from the same runner must not stall on a stale approval.
    rejectAllForConversation(conversationId, 'A newer tool call superseded this approval request.')

    const approvalId = uuidv4()
    const { summary, detail } = buildSummary(request.toolCall.name, request.toolCall.arguments, category)
    const rendererPayload = {
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

    // Headless / app-server path: no live renderer to ask. Pick a static mode.
    if (!window) {
      const headlessMode = context.headlessMode ?? (config.policy === 'off' ? 'auto-approve' : 'deny')
      if (headlessMode === 'auto-approve') return { approved: true }
      return { approved: false, message: 'No renderer available to approve this tool call; denied by policy.' }
    }

    if (!window.isDestroyed()) {
      window.webContents.send(IPC.CHAT_STREAM, {
        conversationId,
        type: 'tool_approval_request',
        toolApproval: rendererPayload,
      })
    }

    return new Promise<ToolApprovalDecision>((resolve) => {
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
        resolve({
          approved: false,
          message: `Approval timed out after ${Math.round(config.timeoutMs / 1000)}s. The tool call was denied.`,
        })
      }, config.timeoutMs)
      pendingApprovals.set(approvalId, {
        conversationId,
        toolName: request.toolCall.name,
        resolve,
        timer,
      })
    })
  }
}
