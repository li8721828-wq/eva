import type { ChatDocumentAttachment } from './conversation'

export type RequirementRunStatus = 'analyzing' | 'awaiting-clarification' | 'awaiting-spec-resolution' | 'ready-for-specification' | 'specifying' | 'ready-for-implementation' | 'failed' | 'cancelled'
export type RequirementDocumentStage = 'source' | 'requirement-analysis' | 'code-analysis' | 'clarification' | 'evaluation' | 'modeling' | 'specification' | 'spec-validation'

export interface RequirementDocument {
  id: string
  runId: string
  round: number
  stage: RequirementDocumentStage
  dimension: string
  title: string
  path: string
  content: string
  createdAt: string
}

export interface RequirementEvaluation {
  dimension: string
  score: number
  threshold: number
  blockers: string[]
  summary: string
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
  createdAt: string
  updatedAt: string
  error?: string
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
}

export interface SubmitSpecificationInput {
  conversationId: string
}

export interface SubmitSpecificationResolutionInput {
  conversationId: string
  runId: string
  answers: RequirementClarificationAnswer[]
}

export type RequirementProgressStage = 'source' | 'requirement-analysis' | 'code-analysis' | 'clarification' | 'evaluation' | 'modeling' | 'specification' | 'spec-validation' | 'complete' | 'failed'

export interface RequirementProgress {
  conversationId: string
  runId?: string
  stage: RequirementProgressStage
  message: string
  document?: RequirementDocument
}
