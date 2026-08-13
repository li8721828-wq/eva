/**
 * Machine-readable envelope shared by tools, the Agent runtime, and model
 * pools. `content` remains available for providers that only accept text, but
 * orchestration decisions must use this envelope instead of parsing prose.
 */
export type ExecutionStatus = 'observed' | 'dispatched' | 'applied' | 'verified' | 'rejected' | 'failed' | 'unknown'

export type ExecutionKind = 'observation' | 'action' | 'analysis' | 'delegation' | 'recovery'

export interface SnapshotRef {
  id: string
  revision: number
  scope: 'desktop' | 'browser' | 'page' | 'canvas'
  capturedAt: string
  validUntil?: string
}

export interface ExecutionEvidence {
  type: 'structured' | 'screenshot' | 'accessibility' | 'dom' | 'api' | 'model'
  summary: string
  sourceId?: string
  confidence?: number
}

export interface ExecutionError {
  code: string
  message: string
  retryable: boolean
  requiresObservation?: boolean
}

export interface ActionProposal {
  tool: string
  arguments: Record<string, unknown>
  reason: string
  expectedState?: Record<string, unknown>
  confidence?: number
}

export interface ExecutionEnvelope {
  protocolVersion: '1'
  operationId: string
  kind: ExecutionKind
  status: ExecutionStatus
  sessionId?: string
  snapshot?: SnapshotRef
  evidence?: ExecutionEvidence[]
  proposedAction?: ActionProposal
  nextAction?: ActionProposal
  error?: ExecutionError
  startedAt?: string
  completedAt?: string
  durationMs?: number
  /** Arbitrary structured facts owned by the producing tool. */
  data?: Record<string, unknown>
}
