export type RuntimeMemoryKind = 'conversation-turn' | 'task-outcome'

export interface RuntimeMemoryEntry {
  id: string
  sourceKey: string
  kind: RuntimeMemoryKind
  conversationId: string
  workspaceId?: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface RecordConversationMemoryInput {
  conversationId: string
  workspaceId?: string
  assistantMessageId: string
  userRequest: string
  outcome: string
  status: 'completed' | 'failed' | 'cancelled'
}

export interface RecordTaskMemoryInput {
  conversationId: string
  workspaceId?: string
  kind: 'goal' | 'team'
  goal: string
  summary?: string
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  updatedAt: number
}
