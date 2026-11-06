import type { ChatDocumentAttachment } from './conversation'

export type RequirementRunStatus = 'analyzing' | 'awaiting-clarification' | 'awaiting-spec-resolution' | 'ready-for-specification' | 'specifying' | 'ready-for-implementation' | 'failed' | 'cancelled'
export type RequirementDocumentStage = 'source' | 'requirement-analysis' | 'code-analysis' | 'clarification' | 'evaluation' | 'modeling' | 'specification' | 'spec-validation' | 'dsl' | 'coding'

export interface RequirementDocument {
  id: string
  runId: string
  round: number
  stage: RequirementDocumentStage
  dimension: string
  title: string
  path: string
  /** Versioned workspace copy for specification-stage documents. */
  workspacePath?: string
  content: string
  createdAt: string
  checkpoint?: { inputHash: string; sha256: string }
}

export interface RequirementEvaluation {
  dimension: string
  score: number
  threshold: number
  blockers: string[]
  summary: string
  /**
   * Machine-readable semantic audit result. New requirement runs use this
   * instead of inferring blockers from prose or heading names.
   */
  readiness?: 'ready' | 'blocked'
  unresolvedItems?: RequirementUnresolvedItem[]
}

export interface RequirementUnresolvedItem {
  id: string
  fact: string
  impact: string
  requiredDecision: string
  blocking: boolean
  options?: string[]
  recommendedIndex?: number
}

export interface RequirementClarificationQuestion {
  id: string
  question: string
  options: string[]
  recommendedIndex: number
  rationale?: string
}

export interface RequirementClarificationAnswer {
  questionId: string
  optionIndex: number
}

export type SpecificationBlockerCategory = 'requirements' | 'modeling' | 'code-evidence' | 'specification'

export interface SpecificationResolutionQuestion extends RequirementClarificationQuestion {
  category: SpecificationBlockerCategory
  blocker: string
  repair?: string
}

export interface RequirementRun {
  id: string
  conversationId: string
  conversationTitle: string
  /** Stable business-derived label used to group this RMSD run, never a chat title. */
  requirementTitle?: string
  status: RequirementRunStatus
  round: number
  qualityScore: number
  qualityThreshold: number
  specQualityScore?: number
  specQualityThreshold?: number
  specResolutionQuestions?: SpecificationResolutionQuestion[]
  specResolutionHandledAt?: string
  documents: RequirementDocument[]
  evaluations: RequirementEvaluation[]
  clarificationQuestions: RequirementClarificationQuestion[]
  /** Canonical worktree that owns the package. */
  workspaceRoot?: string
  /** Published stage outputs and the exact upstream revision each consumed. */
  releases?: Partial<Record<RequirementReleaseStage, RequirementRelease>>
  revision?: number
  draftAttempts?: Partial<Record<'specification' | 'dsl', string>>
  /** Project-local RMSD run root: <workspace>/.eva/RMSD/<requirement-name>/runs/<run-id>. */
  workspacePackagePath?: string
  /** Fixed workspace directory for this requirement package's specification artifacts. */
  workspaceOutputPath?: string
  /** Fixed workspace directory used for DSL-stage artifacts. */
  dslOutputPath?: string
  dslStatus?: 'idle' | 'generating' | 'ready' | 'failed'
  /** Content-addressed fixed output directory used by deterministic code generation. */
  codingOutputPath?: string
  verifiedCoding?: Record<string, { specContract?: RequirementArtifactReceipt; files: Array<{ path: string; sha256: string }> }>
  codingStatus?: 'idle' | 'generating' | 'ready' | 'failed'
  createdAt: string
  updatedAt: string
  error?: string
}

export type RequirementReleaseStage = 'requirement' | 'modeling' | 'specification' | 'dsl'

export interface RequirementArtifactReceipt {
  documentId: string
  sha256: string
}

export interface RequirementRelease extends RequirementArtifactReceipt {
  upstreamDocumentId?: string
  specContract?: RequirementArtifactReceipt
}

export interface SubmitRequirementInput {
  conversationId: string
  content?: string
  attachments?: ChatDocumentAttachment[]
}

export interface SubmitClarificationAnswersInput {
  conversationId: string
  runId: string
  answers: RequirementClarificationAnswer[]
}

export interface SubmitRequirementModelingInput {
  conversationId: string
  runId?: string
}

export interface SubmitSpecificationInput {
  conversationId: string
  /** Explicit requirement run to continue; omitted only for legacy recovery. */
  runId?: string
}

export interface SubmitDslInput {
  conversationId: string
  /** Explicit requirement run to continue; omitted only for legacy recovery. */
  runId?: string
}

export interface SubmitCodingInput {
  conversationId: string
  /** Explicit requirement run to continue; omitted only for legacy recovery. */
  runId?: string
  generator?: string
}

export interface SubmitSpecificationResolutionInput {
  conversationId: string
  runId: string
  answers: RequirementClarificationAnswer[]
}

export type RequirementProgressStage = 'source' | 'requirement-analysis' | 'code-analysis' | 'clarification' | 'evaluation' | 'modeling' | 'specification' | 'spec-validation' | 'dsl' | 'coding' | 'complete' | 'failed'

export interface RequirementProgress {
  conversationId: string
  runId?: string
  stage: RequirementProgressStage
  message: string
  document?: RequirementDocument
  phase?: 'started' | 'completed' | 'failed'
}
