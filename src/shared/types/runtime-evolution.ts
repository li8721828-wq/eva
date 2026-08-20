export const RUNTIME_PROPOSAL_AREAS = ['agent-tools', 'model-routing', 'plugin-permissions', 'code-change', 'other'] as const
export type RuntimeProposalArea = typeof RUNTIME_PROPOSAL_AREAS[number]

export const RUNTIME_PROPOSAL_STATUSES = ['draft', 'approved', 'rejected'] as const
export type RuntimeProposalStatus = typeof RUNTIME_PROPOSAL_STATUSES[number]

export interface RuntimeEvolutionProposal {
  id: string
  title: string
  area: RuntimeProposalArea
  problem: string
  evidence: string[]
  proposedChanges: string[]
  validationPlan: string[]
  rollbackPlan: string[]
  status: RuntimeProposalStatus
  createdBy: 'agent' | 'user'
  sourceConversationId?: string
  decisionNote?: string
  implementation?: {
    conversationId: string
    startedAt: number
  }
  createdAt: number
  updatedAt: number
}

export type CreateRuntimeEvolutionProposal = Omit<RuntimeEvolutionProposal, 'id' | 'status' | 'decisionNote' | 'createdAt' | 'updatedAt'>
