import type { AgentConfig } from './agent'
import type { FileAccessGrant } from './file-access'
import type { AgentSymposium } from './symposium'
import type { ExecutionEnvelope } from './execution-protocol'

export type ConversationPermissionLevel = 'workspace' | 'granted-folders' | 'full-access'
export type ConversationExecutionStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type ConversationTitleSource = 'auto' | 'manual' | 'system'

export interface ChatMessageReference {
  messageId: string
  role: 'user' | 'assistant'
  content: string
  authorName?: string
}

export interface Conversation {
  id: string
  title: string
  /** Distinguishes model-generated titles from titles explicitly chosen by the user. */
  titleSource?: ConversationTitleSource
  agentId: string
  mode: 'normal' | 'expert' | 'goal'
  workspaceId?: string
  /** External message channel that owns this conversation. */
  channel?: 'qq'
  /** Internal team conversations are scoped to the task that created them. */
  parentConversationId?: string
  teamTaskId?: string
  /** Identifies a hidden Goal step conversation owned by the parent task. */
  goalStepId?: string
  /** Full access is an explicit choice for conversations created outside a project. */
  accessScope?: 'workspace' | 'full'
  permissionLevel?: ConversationPermissionLevel
  fileAccessGrants?: FileAccessGrant[]
  /** Controls whether this conversation may use the project's semantic index dimensions. */
  multiDimensionalIndexEnabled?: boolean
  /** Base Git repository used by this conversation, when its workspace is a Git project. */
  gitRepositoryPath?: string
  /** Branch selected for this conversation. Each non-default branch uses an isolated Git worktree. */
  gitBranch?: string
  /** Generated worktree path for the selected branch. */
  gitWorktreePath?: string
  /** Optional shared deliberation that belongs to this conversation. */
  symposium?: AgentSymposium
  /** Most recent agent execution state, retained for conversation navigation. */
  executionStatus?: ConversationExecutionStatus
  executionUpdatedAt?: number
  /** Terminal execution state acknowledgement used by the sidebar reminder. */
  executionStatusAcknowledgedAt?: number
  archived?: boolean
  workspacePath: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Parsed local attachment content used only for model context, never rendered as chat text. */
  attachmentContext?: string
  /** Provider-supplied reasoning shown separately from the final answer. */
  reasoningContent?: string
  /** Safe, user-visible execution record for this response. */
  executionTrace?: ExecutionTraceEntry[]
  /** Chronological provider reasoning, tool calls, and tool feedback. */
  executionTimeline?: ExecutionTimelineEntry[]
  /** A concise, user-visible progress update emitted while work is underway. */
  progressKind?: ProgressUpdateKind
  /** Ordered, user-visible progress retained with the response that produced it. */
  progressUpdates?: ProgressUpdate[]
  /** Files and folders the user attached to this message. Their contents stay local. */
  attachments?: ChatDocumentAttachment[]
  /** Local image references selected explicitly by the user. Base64 data is never persisted. */
  images?: ChatImageAttachment[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  agentId?: string
  agentName?: string
  /** Model connection that produced this message, retained for cost reporting. */
  providerId?: string
  providerName?: string
  model?: string
  /** Provider-reported usage accumulated for this assistant response. */
  usage?: ChatUsage
  /** Local and provider timing captured for this completed response. */
  timing?: ResponseTiming
  /** Provider termination reason, retained to distinguish natural completion from truncation. */
  finishReason?: string
  /** User-curated assistant response, retained in the conversation record. */
  favorited?: boolean
  /** A user-selected prior message that should be supplied as focused context. */
  quotedMessage?: ChatMessageReference
  timestamp: number
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  /** Tokens served from the provider prompt cache, when reported. */
  cachedTokens?: number
  /** Prompt tokens that were not served from cache, when reported or derived. */
  cacheMissTokens?: number
  /** Best-effort estimate calculated from a saved CNY rate card. */
  estimatedCostCny?: number
  /** Estimate in the supplier's native billing currency. */
  estimatedCost?: number
  estimatedCostCurrency?: string
  /** Amount returned directly by the supplier for this request, in its native currency. */
  providerReportedCost?: number
  /** ISO-style currency code returned by the supplier, such as CNY or USD. */
  providerReportedCurrency?: string
  /** Whether the visible cost came from the supplier or a locally saved rate card. */
  costSource?: 'provider' | 'rate-card'
  /** Rate card snapshot used for this response, retained for cost auditability. */
  rateCardId?: string
  rateCardUpdatedAt?: number
  /** A subscription plan has no meaningful per-token charge for this response. */
  pricingMode?: 'token' | 'subscription'
  pricingSourceUrl?: string
  /** Number of model calls that contributed to this response. */
  modelCalls?: number
  /** Provider-reported token usage for each model request within this response. */
  modelCallUsage?: ModelCallUsage[]
  /** Local context accounting recorded immediately before the latest model call. */
  contextDiagnostics?: ContextDiagnostics
}

/** Timing of one upstream model request in a response. */
export interface ModelCallTiming {
  durationMs: number
  /** Time until the provider sent its first stream event, when one was received. */
  timeToFirstResponseMs?: number
}

/** Timing of one local tool operation. */
export interface ToolCallTiming {
  name: string
  durationMs: number
  isError: boolean
}

/** End-to-end timing retained without request content or provider credentials. */
export interface ResponseTiming {
  /** IPC work before the Agent starts, including history, preferences, and attachments. */
  localPreparationMs?: number
  /** Building and fitting the model context for the first upstream request. */
  contextBuildMs?: number
  /** Sum of upstream request durations; parallel work is represented by individual calls below. */
  modelDurationMs: number
  /** First provider response for the initial model request, when available. */
  timeToFirstResponseMs?: number
  /** Sum of local tool execution durations. */
  toolExecutionMs: number
  /** Full elapsed time through Agent completion, excluding final message persistence. */
  totalMs: number
  modelCalls: ModelCallTiming[]
  toolCalls: ToolCallTiming[]
}

/** Usage boundary for one provider request made while producing an assistant reply. */
export interface ModelCallUsage {
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  cacheMissTokens?: number
  /** Local context accounting recorded immediately before this request. */
  contextDiagnostics?: ContextDiagnostics
}

/** Local context accounting; token values remain estimates until the provider reports usage. */
export interface ContextDiagnostics {
  budgetTokens: number
  estimatedTokens: number
  systemTokens: number
  toolDefinitionTokens: number
  retainedMessages: number
  omittedMessages: number
  compactedMessages: number
  estimator: 'heuristic-v2'
}

export interface ChatImageAttachment {
  path: string
  name: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  size: number
  /** Runtime-only data for multimodal providers. Do not persist this field. */
  dataUrl?: string
}

export interface ChatDocumentAttachment {
  path: string
  name: string
  size: number
  kind: 'file' | 'folder'
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  result?: string
  isError?: boolean
  protocol?: ExecutionEnvelope
}

export type ExecutionTraceKind = 'plan' | 'activity' | 'tool' | 'observation' | 'issue' | 'result'
export type ExecutionTraceStatus = 'active' | 'completed' | 'failed'
export type ProgressUpdateKind = 'thinking' | 'finding' | 'action' | 'issue'

export interface ProgressUpdate {
  id: string
  kind: ProgressUpdateKind
  content: string
  timestamp: number
}

/**
 * A concise, verifiable progress event. This intentionally contains a
 * summary of work performed rather than provider chain-of-thought.
 */
export interface ExecutionTraceEntry {
  id: string
  kind: ExecutionTraceKind
  status: ExecutionTraceStatus
  title: string
  detail?: string
  timestamp: number
  toolCallId?: string
}

export interface ExecutionTimelineEntry {
  id: string
  kind: 'reasoning' | 'tool' | 'note'
  timestamp: number
  content?: string
  toolCall?: ToolCall
}

/** A chat Agent has proposed switching the current request into Goal execution. */
export interface GoalConfirmationRequest {
  id: string
  goal: string
  requestedAt: number
}

/**
 * The Agent asked to execute a tool that needs explicit human approval under
 * the current chat policy. Mirrors `ToolApprovalRequest` from the main process
 * (renderer-bound).
 */
export interface ToolApprovalRequest {
  id: string
  /** The tool call that requires approval. */
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
  /** Workspace the call targets; used to render the approval card. */
  workspacePath: string
  /** Why this call was classified as approval-required. */
  category: 'workspace-write' | 'terminal-command' | 'mcp-call' | 'browser-control' | 'other'
  /** A short, user-facing summary of the operation. */
  summary: string
  /** Optional detail line (e.g. the command text or file path preview). */
  detail?: string
  requestedAt: number
}

export interface ChatStreamEvent {
  /** The conversation that owns this stream event. */
  conversationId?: string
  /** The Agent actually selected for this response by the main process. */
  agentId?: string
  agentName?: string
  type: 'thinking' | 'reasoning_delta' | 'text_delta' | 'text_reset' | 'tool_call_start' | 'tool_call_delta' | 'tool_result' | 'execution_trace' | 'execution_timeline' | 'progress' | 'goal_confirmation' | 'tool_approval_request' | 'done' | 'error'
  messageId?: string
  content?: string
  /** True only when provisional text was protocol markup and must be discarded. */
  discardProvisionalText?: boolean
  /** Why provisional text was reset; `protocol-repair` marks an automatic protocol-format retry. */
  reason?: 'protocol-repair' | 'provider-error'
  toolCall?: Partial<ToolCall>
  toolCallId?: string
  toolResult?: string
  isError?: boolean
  protocol?: ExecutionEnvelope
  executionTrace?: ExecutionTraceEntry[]
  executionTimeline?: ExecutionTimelineEntry[]
  progressKind?: ProgressUpdateKind
  goalConfirmation?: GoalConfirmationRequest
  toolApproval?: ToolApprovalRequest
  error?: string
  finishReason?: string
  usage?: ChatUsage
  timing?: ResponseTiming
}
