/**
 * Wire shapes for the Agent Client Protocol side of the loopback server.
 *
 * Eva's own app-server vocabulary is `thread/*` + `turn/*` with an event stream
 * that mirrors the desktop renderer. ACP clients speak `session/*` plus
 * `session/update`, so this module is the translation surface: it names the
 * methods, and types the updates, that the facade in `connection.ts` produces.
 * Only what this server actually sends is declared here.
 */

export const ACP_METHOD = {
  INITIALIZE: 'initialize',
  SESSION_NEW: 'session/new',
  SESSION_PROMPT: 'session/prompt',
  SESSION_CANCEL: 'session/cancel',
  SESSION_UPDATE: 'session/update',
  SESSION_REQUEST_PERMISSION: 'session/request_permission',
} as const

export const ACP_PROTOCOL_VERSION = 1

export const ACP_UPDATE = {
  AGENT_MESSAGE_CHUNK: 'agent_message_chunk',
  AGENT_THOUGHT_CHUNK: 'agent_thought_chunk',
  TOOL_CALL: 'tool_call',
  TOOL_CALL_UPDATE: 'tool_call_update',
  PLAN: 'plan',
} as const

/** ACP stops with one of these; `cancelled` and `refusal` are the two Eva can reach. */
export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'
export type AcpPlanStatus = 'pending' | 'in_progress' | 'completed'
export type AcpPlanPriority = 'high' | 'medium' | 'low'

export interface AcpContentBlock {
  type: 'text'
  text: string
}

export interface AcpPlanEntry {
  content: string
  priority: AcpPlanPriority
  status: AcpPlanStatus
}

export interface AcpToolCall {
  toolCallId: string
  title: string
  kind: 'read' | 'edit' | 'execute' | 'fetch' | 'other'
  status: AcpToolCallStatus
}

export type AcpSessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; messageId: string; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'tool_call'; toolCall: AcpToolCall }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; status: AcpToolCallStatus }
  | { sessionUpdate: 'plan'; entries: AcpPlanEntry[] }

export interface AcpSessionNotification {
  sessionId: string
  update: AcpSessionUpdate
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface AcpPermissionOutcome {
  outcome: 'selected'
  optionId: string
}

/** The client either picked an option or dismissed the prompt without choosing. */
export interface AcpPermissionResult {
  outcome: AcpPermissionOutcome | { outcome: 'cancelled' }
}
