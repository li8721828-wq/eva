import { beforeEach, describe, expect, it, vi } from 'vitest'

const cancel = vi.fn()

vi.stubGlobal('window', { eva: { task: { cancel } } })

describe('expert task cancellation', () => {
  beforeEach(async () => {
    cancel.mockReset()
    cancel.mockResolvedValue(true)
    const { useTaskStore } = await import('../../src/renderer/stores/use-task-store')
    useTaskStore.setState({ expertTasks: {}, goalTasks: {} })
  })

  it('clears the running state immediately and ignores late team events', async () => {
    const { useTaskStore } = await import('../../src/renderer/stores/use-task-store')
    useTaskStore.setState({ expertTasks: { task: { currentPlan: null, isRunning: true, summary: null } } })

    const cancellation = useTaskStore.getState().abortExpertTask('task')
    expect(useTaskStore.getState().expertTasks.task).toMatchObject({ isRunning: false, recoveryStatus: 'cancelled' })

    useTaskStore.getState().handleTeamEvent({ type: 'plan_created', conversationId: 'task', plan: { id: 'plan', goal: 'late', subtasks: [], status: 'in_progress', createdAt: Date.now() } })
    expect(useTaskStore.getState().expertTasks.task).toMatchObject({ currentPlan: null, isRunning: false, recoveryStatus: 'cancelled' })
    await cancellation
  })
})
