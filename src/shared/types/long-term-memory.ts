export type LongTermMemoryScope = 'user' | 'project'

export type LongTermMemoryKind =
  | 'preference'
  | 'decision'
  | 'fact'
  | 'bug'
  | 'workflow'
  | 'constraint'

export type LongTermMemoryStatus = 'pending' | 'active' | 'rejected' | 'superseded' | 'archived'

export interface LongTermMemoryEvidence {
  conversationId: string
  messageId?: string
  summary: string
  recordedAt: number
}

export interface LongTermMemory {
  id: string
  sourceKey: string
  scope: LongTermMemoryScope
  scopeId: string
  kind: LongTermMemoryKind
  status: LongTermMemoryStatus
  title: string
  content: string
  tags: string[]
  confidence: number
  importance: number
  evidence: LongTermMemoryEvidence[]
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export interface LongTermMemoryProjectScope {
  workspaceId?: string
  workspacePath?: string
}

export interface UpsertLongTermMemoryInput {
  id?: string
  sourceKey: string
  scope: LongTermMemoryScope
  scopeId: string
  kind: LongTermMemoryKind
  status?: LongTermMemoryStatus
  title: string
  content: string
  tags?: string[]
  confidence?: number
  importance?: number
  evidence?: LongTermMemoryEvidence[]
}

export interface UpdateLongTermMemoryInput {
  status?: LongTermMemoryStatus
  title?: string
  content?: string
  tags?: string[]
  confidence?: number
  importance?: number
}

export interface MemoryEventToolSummary {
  name: string
  target?: string
  resultSummary?: string
  isError?: boolean
}

/** The bounded handoff from the task agent to the dedicated memory agent. */
export interface MemoryEvent {
  conversationId: string
  messageId: string
  userId?: string
  workspaceId?: string
  workspacePath?: string
  userRequest: string
  assistantResult: string
  status: 'completed' | 'failed' | 'cancelled'
  changedFiles?: string[]
  toolCalls?: MemoryEventToolSummary[]
}

export interface MemoryAgentCandidate {
  action: 'upsert' | 'supersede' | 'ignore'
  existingId?: string
  scope: LongTermMemoryScope
  kind: LongTermMemoryKind
  title: string
  content: string
  tags?: string[]
  confidence?: number
  importance?: number
}
