export interface ImplementRequirementInput {
  conversationId: string
  runId: string
  mode: 'confirmed' | 'assumptions'
}

export interface RequirementImplementation {
  taskId: string
  inputHash: string
  conversationId: string
  mode: ImplementRequirementInput['mode']
  worktreePath: string
  branch: string
  baselineCommit: string
  createdAt: string
}

export interface ImplementationHandoff extends RequirementImplementation {
  messageId: string
  message: string
  agentId: string
}

export interface ImplementationReview {
  conversationId: string
  executionStatus?: string
  files: string[]
  patch: string
  patchPath: string
  patchSha256: string
  truncated: boolean
  acceptance: 'pending'
}
