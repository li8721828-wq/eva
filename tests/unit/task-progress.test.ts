import { describe, expect, it } from 'vitest'
import { markGoalProgressCancelled, markGoalProgressFailed } from '../../src/shared/types/task'

describe('markGoalProgressCancelled', () => {
  it('cancels only the active step and preserves resumable pending work', () => {
    const stoppedAt = 1_725_000_000_000
    const progress = markGoalProgressCancelled({
      goal: 'Inspect the model landscape',
      currentStepIndex: 1,
      totalSteps: 3,
      status: 'in_progress',
      startedAt: stoppedAt - 5_000,
      steps: [
        { id: 'completed', index: 0, description: 'Completed', status: 'completed' },
        { id: 'active', index: 1, description: 'Active', status: 'in_progress', startedAt: stoppedAt - 1_000 },
        { id: 'pending', index: 2, description: 'Pending', status: 'pending' },
      ],
    }, stoppedAt)

    expect(progress.status).toBe('cancelled')
    expect(progress.completedAt).toBe(stoppedAt)
    expect(progress.steps.map((step) => step.status)).toEqual(['completed', 'cancelled', 'pending'])
    expect(progress.steps[1].completedAt).toBe(stoppedAt)
  })

  it('marks the active step as failed when startup or recovery fails', () => {
    const failedAt = 1_725_000_010_000
    const progress = markGoalProgressFailed({
      goal: 'Resume research',
      currentStepIndex: 2,
      totalSteps: 3,
      status: 'in_progress',
      startedAt: failedAt - 5_000,
      steps: [
        { id: 'completed', index: 0, description: 'Completed', status: 'completed' },
        { id: 'active', index: 1, description: 'Active', status: 'in_progress' },
        { id: 'pending', index: 2, description: 'Pending', status: 'pending' },
      ],
    }, 'No available model connection', failedAt)

    expect(progress.status).toBe('failed')
    expect(progress.steps.map((step) => step.status)).toEqual(['completed', 'failed', 'pending'])
    expect(progress.steps[1]).toMatchObject({ result: 'No available model connection', completedAt: failedAt })
  })
})
