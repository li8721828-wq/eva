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
  /** Local context accounting recorded immediately before the latest model call. */
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
  kind: 'reasoning' | 'tool'
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

export interface ChatStreamEvent {
  /** The conversation that owns this stream event. */
  conversationId?: string
  /** The Agent actually selected for this response by the main process. */
  agentId?: string
  agentName?: string
  type: 'thinking' | 'reasoning_delta' | 'text_delta' | 'text_reset' | 'tool_call_start' | 'tool_call_delta' | 'tool_result' | 'execution_trace' | 'execution_timeline' | 'progress' | 'goal_confirmation' | 'done' | 'error'
  messageId?: string
  content?: string
  toolCall?: Partial<ToolCall>
  toolCallId?: string
  toolResult?: string
  isError?: boolean
  protocol?: ExecutionEnvelope
  executionTrace?: ExecutionTraceEntry[]
  executionTimeline?: ExecutionTimelineEntry[]
  progressKind?: ProgressUpdateKind
  goalConfirmation?: GoalConfirmationRequest
  error?: string
  finishReason?: string
  usage?: ChatUsage
}
