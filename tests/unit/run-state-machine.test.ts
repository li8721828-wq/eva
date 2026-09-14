import { describe, expect, it } from 'vitest'
import { canTransitionRun, isTerminalRunStatus, transitionRun } from '../../src/main/services/run-state-machine'

describe('unified run state machine', () => {
  it('allows normal execution and recovery paths', () => {
    expect(canTransitionRun('queued', 'running')).toBe(true)
    expect(canTransitionRun('running', 'paused')).toBe(true)
    expect(canTransitionRun('paused', 'running')).toBe(true)
    expect(canTransitionRun('failed', 'queued')).toBe(true)
    expect(canTransitionRun('interrupted', 'running')).toBe(true)
  })

  it('rejects stale or backwards transitions after terminal state', () => {
    expect(transitionRun('completed', 'running')).toMatchObject({ accepted: false, from: 'completed', to: 'running' })
    expect(transitionRun('cancelled', 'completed').accepted).toBe(false)
    expect(canTransitionRun('running', 'queued')).toBe(false)
    expect(isTerminalRunStatus('completed')).toBe(true)
    expect(isTerminalRunStatus('running')).toBe(false)
  })
})
