export const RUNTIME_PROCESS_KINDS = ['agent', 'goal', 'team'] as const
export type RuntimeProcessKind = typeof RUNTIME_PROCESS_KINDS[number]

export const RUNTIME_PROCESS_STATUSES = ['queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted'] as const
export type RuntimeProcessStatus = typeof RUNTIME_PROCESS_STATUSES[number]

export interface RuntimeKernelProcess {
  id: string
  conversationId: string
  kind: RuntimeProcessKind
  status: RuntimeProcessStatus
  agentId?: string
  workspaceId?: string
  resourceKeys?: string[]
  startedAt: number
  updatedAt: number
  finishedAt?: number
  summary?: string
  error?: string
}

export interface RuntimeKernelAuditRecord {
  id: string
  timestamp: number
  processId: string
  conversationId: string
  kind: RuntimeProcessKind
  from?: RuntimeProcessStatus
  to: RuntimeProcessStatus
  detail?: string
}

export interface RuntimeKernelSnapshot {
  generatedAt: number
  revision: number
  activeProcessCount: number
  queuedProcessCount: number
  resourceLocks: RuntimeKernelResourceLock[]
  processes: RuntimeKernelProcess[]
}

export interface RuntimeKernelResourceLock {
  resourceKey: string
  processIds: string[]
}

export interface StartRuntimeProcessInput {
  conversationId: string
  kind: RuntimeProcessKind
  status?: Extract<RuntimeProcessStatus, 'queued' | 'running'>
  agentId?: string
  workspaceId?: string
  summary?: string
  resourceKeys?: string[]
  /** A child execution can coexist with the parent chat process. */
  supersede?: boolean
}
