import type { ChatDocumentAttachment } from './conversation'

export type CodeProductionRunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface CodeProductionPluginStatus {
  configured: boolean
  enabled: boolean
  message: string
  allowedProjectRoot?: string
  pipelineRoot?: string
  fingerprint?: string
}

export interface CodeProductionWorkspace {
  id: string
  label: string
  kind: string
  configPath: string
  production: boolean
}

export interface CodeProductionRun {
  id: string
  workspaceId: string
  workspaceLabel: string
  status: CodeProductionRunStatus
  mode: 'validate' | 'execute' | 'apply'
  outputDirectory: string
  startedAt: string
  completedAt?: string
  stdout: string
  stderr: string
  error?: string
  reportPath?: string
  deliveryPlanPath?: string
  journalPath?: string
}

export interface StartCodeProductionRunInput {
  workspaceId: string
  execute: boolean
  verificationWorktree?: string
}

export interface ApplyCodeProductionRunInput {
  runId: string
  approvalFile: string
  operatorIdentity: string
  approvalReference: string
  confirmation: string
}

export type CodeProductionDraftStageId = 'source' | 'requirement' | 'specification' | 'dsl' | 'code'
export type CodeProductionDraftStageStatus = 'pending' | 'generating' | 'ready' | 'confirmed' | 'failed'

export interface CodeProductionDraftFile {
  path: string
  content: string
  language: 'markdown' | 'yaml' | 'java' | 'xml' | 'text'
}

export interface CodeProductionDraftStage {
  id: CodeProductionDraftStageId
  label: string
  status: CodeProductionDraftStageStatus
  summary: string
  inputFiles: CodeProductionDraftFile[]
  files: CodeProductionDraftFile[]
  processFiles: CodeProductionDraftFile[]
  confirmedAt?: string
  error?: string
}

export interface CodeProductionClarificationOption {
  id: string
  label: string
  description: string
}

export interface CodeProductionClarificationQuestion {
  id: string
  question: string
  rationale: string
  options: CodeProductionClarificationOption[]
}

export interface CodeProductionRequirementAnswer {
  round: number
  content: string
  submittedAt: string
}

/** Durable state for the requirement-input gate before requirement modeling. */
export interface CodeProductionRequirementIntake {
  status: 'awaiting_clarification' | 'ready_for_modeling'
  round: number
  questions: CodeProductionClarificationQuestion[]
  answers: CodeProductionRequirementAnswer[]
  assessment: string
}

export interface CodeProductionDraft {
  id: string
  conversationId: string
  conversationTitle: string
  status: 'review' | 'generating' | 'completed' | 'failed'
  directory: string
  createdAt: string
  updatedAt: string
  stages: CodeProductionDraftStage[]
  requirementIntake?: CodeProductionRequirementIntake
  error?: string
}

export interface CodeProductionDraftProgress {
  draftId: string
  stageId: CodeProductionDraftStageId
  status: CodeProductionDraftStageStatus
  message: string
}

/** Fixed commands supported by the conversational code-production pipeline. */
export type CodeProductionCommand = 'requirement' | 'requirement-modeling' | 'spec' | 'dsl' | 'coding'

export interface RunCodeProductionCommandInput {
  conversationId: string
  command: CodeProductionCommand
  /** Optional text supplied after `/requirement`. */
  content?: string
  /** Requirement source files supplied with `/requirement`. */
  attachments?: ChatDocumentAttachment[]
}
