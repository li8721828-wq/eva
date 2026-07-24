import type { AgentConfig } from './agent'
import type { FileAccessGrant } from './file-access'

export type ConversationPermissionLevel = 'workspace' | 'granted-folders' | 'full-access'

export interface Conversation {
  id: string
  title: string
  agentId: string
  mode: 'normal' | 'expert' | 'goal'
  workspaceId?: string
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
  toolCalls?: ToolCall[]
  toolCallId?: string
  agentId?: string
  agentName?: string
  timestamp: number
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  result?: string
  isError?: boolean
}

export interface ChatStreamEvent {
  type: 'text_delta' | 'tool_call_start' | 'tool_call_delta' | 'tool_result' | 'done' | 'error'
  messageId?: string
  content?: string
  toolCall?: Partial<ToolCall>
  toolCallId?: string
  toolResult?: string
  error?: string
  finishReason?: string
}
