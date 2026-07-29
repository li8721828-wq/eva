import { beforeEach, describe, expect, it } from 'vitest'
import type { TaskPlan } from '../../src/shared/types'
import { useTaskStore } from '../../src/renderer/stores/use-task-store'

const plan = (id: string): TaskPlan => ({
  id,
  goal: `Goal ${id}`,
  createdAt: Date.now(),
  status: 'in_progress',
  subtasks: [{ id: `${id}-task`, planId: id, title: 'Task', description: 'Task description', status: 'pending', dependencies: [] }],
})

describe('task store conversation isolation', () => {
  beforeEach(() => {
    useTaskStore.setState({ expertTasks: {}, goalTasks: {} })
  })

  it('keeps expert task progress scoped to its conversation', () => {
    const store = useTaskStore.getState()
    store.handleTeamEvent({ type: 'plan_created', conversationId: 'conversation-a', plan: plan('a') })
    store.handleTeamEvent({ type: 'plan_created', conversationId: 'conversation-b', plan: plan('b') })
    store.handleTeamEvent({
      type: 'task_completed',
      conversationId: 'conversation-a',
      subtaskId: 'a-task',
      result: 'Only A completed',
    })

    expect(useTaskStore.getState().expertTasks['conversation-a'].currentPlan?.subtasks[0]).toMatchObject({ status: 'completed', result: 'Only A completed' })
    expect(useTaskStore.getState().expertTasks['conversation-b'].currentPlan?.subtasks[0]).toMatchObject({ status: 'pending' })
  })

  it('keeps goal streaming content scoped to its conversation', () => {
    const store = useTaskStore.getState()
    store.handleGoalEvent({ type: 'goal_started', conversationId: 'conversation-a', goal: 'Goal A' })
    store.handleGoalEvent({ type: 'goal_started', conversationId: 'conversation-b', goal: 'Goal B' })
    store.handleGoalEvent({ type: 'step_progress', conversationId: 'conversation-a', stepId: 'a-step', content: 'A output' })

    expect(useTaskStore.getState().goalTasks['conversation-a'].streamingContent).toBe('A output')
    expect(useTaskStore.getState().goalTasks['conversation-b'].streamingContent).toBe('')
  })
})
