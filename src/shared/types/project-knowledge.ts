export type ProjectKnowledgeKind =
  | 'bug'
  | 'direction'
  | 'change'
  | 'regression-guard'
  | 'decision'

export type ProjectKnowledgeStatus = 'open' | 'resolved' | 'accepted-risk' | 'superseded'

export interface ProjectKnowledgeScope {
  workspaceId?: string
  workspacePath?: string
}

export interface ProjectKnowledgeEntry extends ProjectKnowledgeScope {
  id: string
  sourceKey: string
  kind: ProjectKnowledgeKind
  status: ProjectKnowledgeStatus
  title: string
  summary: string
  symptoms?: string
  rootCause?: string
  resolution?: string
  affectedFiles: string[]
  verification?: string
  regressionGuard?: string
  tags: string[]
  conversationId?: string
  createdAt: number
  updatedAt: number
}

export interface RecordProjectKnowledgeInput extends ProjectKnowledgeScope {
  sourceKey?: string
  kind: ProjectKnowledgeKind
  status?: ProjectKnowledgeStatus
  title: string
  summary: string
  symptoms?: string
  rootCause?: string
  resolution?: string
  affectedFiles?: string[]
  verification?: string
  regressionGuard?: string
  tags?: string[]
  conversationId?: string
}

export interface RecordEngineeringTurnInput extends ProjectKnowledgeScope {
  conversationId: string
  assistantMessageId: string
  userRequest: string
  assistantContent: string
  status: 'completed' | 'failed' | 'cancelled'
  toolCalls?: Array<{
    name: string
    arguments: Record<string, unknown>
    result?: string
    isError?: boolean
  }>
}
