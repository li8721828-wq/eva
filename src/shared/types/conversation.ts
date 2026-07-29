import type { AgentConfig } from './agent'
import type { FileAccessGrant } from './file-access'

export type ConversationPermissionLevel = 'workspace' | 'granted-folders' | 'full-access'

export interface Conversation {
  id: string
  title: string
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
  /** Local image references selected explicitly by the user. Base64 data is never persisted. */
  images?: ChatImageAttachment[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  agentId?: string
  agentName?: string
  timestamp: number
}

export interface ChatImageAttachment {
  path: string
  name: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  size: number
  /** Runtime-only data for multimodal providers. Do not persist this field. */
  dataUrl?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  result?: string
  isError?: boolean
}

export interface ChatStreamEvent {
  type: 'thinking' | 'text_delta' | 'tool_call_start' | 'tool_call_delta' | 'tool_result' | 'done' | 'error'
  messageId?: string
  content?: string
  toolCall?: Partial<ToolCall>
  toolCallId?: string
  toolResult?: string
  isError?: boolean
  error?: string
  finishReason?: string
}
