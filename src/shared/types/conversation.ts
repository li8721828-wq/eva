import type { AgentConfig } from './agent'
import type { FileAccessGrant } from './file-access'
import type { AgentSymposium } from './symposium'

export type ConversationPermissionLevel = 'workspace' | 'granted-folders' | 'full-access'
export type ConversationExecutionStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type ConversationTitleSource = 'auto' | 'manual' | 'system'

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
  /** User-curated assistant response, retained in the conversation record. */
  favorited?: boolean
  timestamp: number
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  /** Tokens served from the provider prompt cache, when reported. */
  cachedTokens?: number
  /** Prompt tokens that were not served from cache, when reported or derived. */
  cacheMissTokens?: number
  /** Best-effort estimate based on the configured provider/model pricing table. */
  estimatedCostCny?: number
  /** Number of model calls that contributed to this response. */
  modelCalls?: number
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
}

export interface ChatStreamEvent {
  /** The conversation that owns this stream event. */
  conversationId?: string
  type: 'thinking' | 'reasoning_delta' | 'text_delta' | 'tool_call_start' | 'tool_call_delta' | 'tool_result' | 'done' | 'error'
  messageId?: string
  content?: string
  toolCall?: Partial<ToolCall>
  toolCallId?: string
  toolResult?: string
  isError?: boolean
  error?: string
  finishReason?: string
  usage?: ChatUsage
}
