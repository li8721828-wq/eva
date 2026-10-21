import type { Conversation } from './conversation'

export type PurposeStatus = 'active' | 'paused' | 'completed'
export type MilestoneStatus = 'pending' | 'in_progress' | 'blocked' | 'completed'

export interface PurposeMilestone {
  id: string
  title: string
  status: MilestoneStatus
  evidence: string
}

/** No source bodies, patches, credentials, command arguments, or raw model output. */
export interface PurposeCodeState {
  kind: 'git' | 'unavailable'
  branch?: string
  commit?: string
  fingerprint?: string
  dirty?: boolean
  changedFileCount?: number
  capturedAt: number
}

export interface PurposeExecution {
  id: string
  conversationId: string
  status: string
  recordedAt: number
  model?: string
  tools: Array<{ id: string; name: string; status: 'succeeded' | 'failed' | 'unknown'; exitCode?: number }>
  steps: Array<{ title: string; status: string }>
  code: PurposeCodeState
}

export interface PurposeHandoff {
  id: string
  createdAt: number
  revision: number
  summary: string
  blockers: string
  nextAction: string
  code: PurposeCodeState
}

export interface Purpose {
  schemaVersion: 1
  id: string
  revision: number
  title: string
  objective: string
  scope: string
  acceptanceCriteria: string[]
  milestones: PurposeMilestone[]
  status: PurposeStatus
  notes: Array<{ id: string; kind: 'decision' | 'finding'; content: string; createdAt: number }>
  executions: PurposeExecution[]
  handoffs: PurposeHandoff[]
  history: Array<{ revision: number; at: number; kind: string; detail: string }>
  createdAt: number
  updatedAt: number
}

export interface CreatePurposeInput {
  title: string
  objective: string
  scope: string
  acceptanceCriteria: string[]
  milestones: string[]
  /** Unconfirmed planning notes retained from a reviewed AI draft. */
  planningNotes?: string[]
}

export interface GeneratePurposeDraftInput {
  requestId: string
  workspaceId: string
  request: string
  /** Only included when the user selects the same-project conversation as a source. */
  conversationId?: string
  language: 'zh' | 'en' | 'ja'
}

export interface PurposeDraftAnalysis {
  draft: CreatePurposeInput
  assumptions: string[]
  questions: string[]
  source: { conversationMessages: number; indexedFiles: number; indexAvailable: boolean }
  model: string
}

export interface UpdatePurposeInput {
  revision: number
  title: string
  objective: string
  scope: string
  acceptanceCriteria: string[]
  milestones: PurposeMilestone[]
  status: PurposeStatus
  /** Required for scope changes or marking the whole purpose complete. */
  reason: string
}

export interface PurposeRef { workspaceId: string; purposeId: string }
export interface PurposeProgressReport {
  revision: number
  summary: string
  evidence: string
  blockers: string
  nextAction: string
  milestoneId?: string
  milestoneStatus?: 'in_progress' | 'blocked'
}
export interface PurposeHandoffInput extends PurposeRef {
  revision: number
  summary: string
  blockers: string
  nextAction: string
}
export interface PurposePreflight {
  revision: number
  currentCode: PurposeCodeState
  comparison: 'match' | 'changed' | 'unknown' | 'no-handoff'
  latestHandoff?: PurposeHandoff
}
export interface ContinuePurposeInput extends PurposeRef {
  revision: number
  /** Binds the explicit review to the inspected working tree. */
  fingerprint?: string
  acknowledgeChanged: boolean
}
export interface PurposeAPI {
  generateDraft(input: GeneratePurposeDraftInput): Promise<PurposeDraftAnalysis>
  cancelDraft(requestId: string): Promise<void>
  list(workspaceId: string): Promise<Purpose[]>
  create(workspaceId: string, input: CreatePurposeInput): Promise<Purpose>
  update(ref: PurposeRef, input: UpdatePurposeInput): Promise<Purpose>
  note(ref: PurposeRef, revision: number, kind: 'decision' | 'finding', content: string): Promise<Purpose>
  handoff(input: PurposeHandoffInput): Promise<Purpose>
  preflight(ref: PurposeRef): Promise<PurposePreflight>
  continue(input: ContinuePurposeInput): Promise<Conversation>
  attach(ref: PurposeRef, conversationId: string): Promise<void>
}
