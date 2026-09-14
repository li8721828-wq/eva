import type { RuntimeProcessStatus } from '../../shared/types/runtime-kernel'

/** Canonical lifecycle states shared by interactive and Agent OS runs. */
export type UnifiedRunStatus = RuntimeProcessStatus | 'cancelling'

const TERMINAL = new Set<UnifiedRunStatus>(['completed', 'failed', 'cancelled', 'interrupted'])
const TRANSITIONS: Record<UnifiedRunStatus, ReadonlySet<UnifiedRunStatus>> = {
  // Legacy/manual conversations may persist their first result without a
  // separate running checkpoint, so queued -> completed remains valid.
  queued: new Set(['running', 'completed', 'cancelled', 'failed', 'interrupted']),
  running: new Set(['paused', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted']),
  paused: new Set(['running', 'cancelling', 'cancelled', 'failed', 'interrupted']),
  cancelling: new Set(['cancelled', 'failed', 'interrupted']),
  completed: new Set(),
  failed: new Set(['queued', 'running']),
  cancelled: new Set(['queued', 'running']),
  interrupted: new Set(['queued', 'running']),
}

export interface RunTransitionResult { accepted: boolean; from: UnifiedRunStatus; to: UnifiedRunStatus; reason?: string }

export function isTerminalRunStatus(status: UnifiedRunStatus): boolean { return TERMINAL.has(status) }
export function canTransitionRun(from: UnifiedRunStatus, to: UnifiedRunStatus): boolean { return from === to || TRANSITIONS[from].has(to) }
export function transitionRun(from: UnifiedRunStatus, to: UnifiedRunStatus): RunTransitionResult {
  if (canTransitionRun(from, to)) return { accepted: true, from, to }
  return { accepted: false, from, to, reason: 'Illegal run state transition: ' + from + ' -> ' + to + '.' }
}
export function assertRunTransition(from: UnifiedRunStatus, to: UnifiedRunStatus): void {
  const result = transitionRun(from, to)
  if (!result.accepted) throw new Error(result.reason)
}
