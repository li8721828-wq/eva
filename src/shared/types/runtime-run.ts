import type { RuntimeProcessKind, RuntimeProcessStatus } from './runtime-kernel'

export type RuntimeRunRecoveryMode = 'auto-queued' | 'checkpointed-manual' | 'none'
export type RuntimeRunStatus = RuntimeProcessStatus | 'replayed'

export interface RuntimeRunMetrics {
  durationMs?: number
  modelCalls?: number
  promptTokens?: number
  completionTokens?: number
  toolCalls?: number
  cost?: number
  currency?: string
}

export interface RuntimeRunPayload {
  /** Reconstructible request data only; never model reasoning or raw tool output. */
  goal?: string
  agentId?: string
  resume?: boolean
  recoveryReason?: 'app-restart' | 'user-continue'
  config?: {
    maxSteps?: number
    timeout?: number
    autoAdjust?: boolean
  }
  messageId?: string
  idempotencyKey?: string
  recoverySummary?: AgentRunRecoverySummary
}

/**
 * Durable, replayable description of an Agent OS execution. The matching
 * RuntimeKernel process holds lifecycle/audit state; TaskRunStore holds the
 * domain checkpoint and plan.
 */
export interface RuntimeRunDescriptor {
  id: string
  conversationId: string
  kind: RuntimeProcessKind
  status: RuntimeRunStatus
  workspaceId?: string
  resourceKeys: string[]
  payload?: RuntimeRunPayload
  recoveryMode: RuntimeRunRecoveryMode
  /** Stable per-run key reserved for side-effect deduplication during replay. */
  idempotencyKey: string
  createdAt: number
  updatedAt: number
  recoveryCount: number
  lastRecoveryAt?: number
  detail?: string
  metrics?: RuntimeRunMetrics
}

export type AgentRunEventType =
  | 'run_started' | 'turn_started' | 'model_call_started' | 'model_call_completed'
  | 'tool_started' | 'tool_completed' | 'approval_requested' | 'turn_interrupted'
  | 'turn_completed' | 'run_failed' | 'run_completed'

/** Append-only execution item used for replay, diagnostics, and recovery. */
export interface AgentRunEvent {
  id: string
  runId: string
  turnId: string
  sequence: number
  type: AgentRunEventType
  timestamp: number
  item?: {
    id: string
    kind: 'model_call' | 'tool_call' | 'approval' | 'assistant_output' | 'system'
    status: 'started' | 'completed' | 'failed' | 'cancelled'
    name?: string
    content?: string
    error?: string
  }
  metadata?: Record<string, string | number | boolean | null>
}

export interface AgentRunRecoverySummary {
  runId: string
  lastTurnId?: string
  interrupted: boolean
  incompleteItems: Array<{ id: string; kind: 'model_call' | 'tool_call' | 'approval' | 'assistant_output' | 'system'; name?: string }>
  lastEventType?: AgentRunEventType
  generatedAt: number
}
