import type { RuntimeProcessKind, RuntimeProcessStatus } from './runtime-kernel'

export type RuntimeRunRecoveryMode = 'auto-queued' | 'checkpointed-manual' | 'none'
export type RuntimeRunStatus = RuntimeProcessStatus | 'replayed'

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
}
