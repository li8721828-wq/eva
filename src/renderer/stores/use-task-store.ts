import { markGoalProgressCancelled, markGoalProgressFailed, type GoalConfig, type GoalProgress, type SubTask, type TaskPlan, type TeamEvent, type TaskRunSnapshot } from '../../shared/types'
import type { GoalEvent } from '../lib/goal-event'
import { create } from 'zustand'

export interface ExpertTaskState {
  currentPlan: TaskPlan | null
  isRunning: boolean
  summary: string | null
  recoveryStatus?: TaskRunSnapshot['status']
}

export interface GoalTaskState {
  progress: GoalProgress | null
  streamingContent: string
  isRunning: boolean
  isPaused: boolean
  recoveryStatus?: TaskRunSnapshot['status']
}

export const EMPTY_EXPERT_TASK: ExpertTaskState = { currentPlan: null, isRunning: false, summary: null }
export const EMPTY_GOAL_TASK: GoalTaskState = { progress: null, streamingContent: '', isRunning: false, isPaused: false }

type ScopedTeamEvent = TeamEvent & { conversationId?: string }

interface TaskState {
  expertTasks: Record<string, ExpertTaskState>
  goalTasks: Record<string, GoalTaskState>
  getExpertTask: (conversationId?: string | null) => ExpertTaskState
  getGoalTask: (conversationId?: string | null) => GoalTaskState
  handleTeamEvent: (event: ScopedTeamEvent) => void
  startExpertTask: (goal: string, conversationId?: string) => Promise<void>
  abortExpertTask: (conversationId?: string) => Promise<void>
  clearPlan: (conversationId?: string) => void
  startGoal: (goal: string, agentId: string, conversationId: string, config?: Partial<GoalConfig>) => void
  abortGoal: (conversationId: string) => Promise<void>
  pauseGoal: (conversationId: string) => Promise<void>
  resumeGoal: (conversationId: string) => Promise<void>
  clearGoalProgress: (conversationId?: string) => void
  handleGoalEvent: (event: GoalEvent) => void
  hydrateSnapshot: (snapshot: TaskRunSnapshot | null) => void
}

function updateTask<T>(
  tasks: Record<string, T>,
  conversationId: string,
  update: (current: T) => T,
  fallback: T,
): Record<string, T> {
  return { ...tasks, [conversationId]: update(tasks[conversationId] || fallback) }
}

export const useTaskStore = create<TaskState>((set, get) => ({
  expertTasks: {},
  goalTasks: {},

  getExpertTask: (conversationId) => conversationId ? get().expertTasks[conversationId] || EMPTY_EXPERT_TASK : EMPTY_EXPERT_TASK,
  getGoalTask: (conversationId) => conversationId ? get().goalTasks[conversationId] || EMPTY_GOAL_TASK : EMPTY_GOAL_TASK,

  handleTeamEvent: (event) => {
    const conversationId = event.conversationId
    if (!conversationId) return

    set((state) => {
      const current = state.expertTasks[conversationId] || EMPTY_EXPERT_TASK
      if (current.recoveryStatus === 'cancelled') return state
      let next = current

      switch (event.type) {
        case 'plan_created':
          next = { currentPlan: event.plan || null, isRunning: true, summary: null }
          break
        case 'task_assigned':
        case 'task_progress':
        case 'task_completed':
        case 'task_failed': {
          if (!current.currentPlan || !event.subtaskId) return state
          const status = event.type === 'task_assigned' ? 'pending'
            : event.type === 'task_progress' ? 'in_progress'
              : event.type === 'task_completed' ? 'completed' : 'failed'
          const result = event.progress || event.result || event.error
          next = {
            ...current,
            currentPlan: {
              ...current.currentPlan,
              subtasks: current.currentPlan.subtasks.map((subtask) => subtask.id === event.subtaskId
                ? {
                    ...subtask,
                    ...event.subtask,
                    assignedAgentId: event.agentId || subtask.assignedAgentId,
                    assignedAgentName: event.agentName || subtask.assignedAgentName,
                    status,
                    result: result || subtask.result,
                    completedAt: status === 'completed' || status === 'failed' ? Date.now() : subtask.completedAt,
                  }
                : subtask),
            },
          }
          break
        }
        case 'summary':
          next = { ...current, summary: event.summary || null }
          break
        case 'done':
        case 'error':
          next = { ...current, isRunning: false }
          break
      }

      return { expertTasks: { ...state.expertTasks, [conversationId]: next } }
    })
  },

  startExpertTask: async (goal, conversationId) => {
    let convId = conversationId
    if (!convId) {
      const conversation = await window.eva.conversation.create({ title: `Expert: ${goal.slice(0, 60)}`, mode: 'expert' })
      convId = conversation.id
    }
    set((state) => ({
      expertTasks: { ...state.expertTasks, [convId!]: { currentPlan: null, isRunning: true, summary: null } },
    }))
    try {
      await window.eva.task.start(convId, goal)
    } catch (error) {
      console.error('Failed to start expert task:', error)
      set((state) => ({
        expertTasks: updateTask(state.expertTasks, convId!, (task) => ({ ...task, isRunning: false }), EMPTY_EXPERT_TASK),
      }))
    }
  },

  abortExpertTask: async (conversationId) => {
    if (!conversationId) return
    set((state) => ({
      expertTasks: updateTask(state.expertTasks, conversationId, (task) => ({ ...task, isRunning: false, recoveryStatus: 'cancelled' }), EMPTY_EXPERT_TASK),
    }))
    try {
      await window.eva.task.cancel(conversationId)
    } catch (error) {
      console.error('Failed to abort expert task:', error)
    }
  },

  clearPlan: (conversationId) => {
    if (!conversationId) return
    set((state) => {
      const { [conversationId]: _removed, ...expertTasks } = state.expertTasks
      return { expertTasks }
    })
  },

  startGoal: (goal, agentId, conversationId, config) => {
    if (!conversationId) return
    set((state) => ({
      goalTasks: { ...state.goalTasks, [conversationId]: { progress: null, streamingContent: '', isRunning: true, isPaused: false } },
    }))
    window.eva.goal.start({ goal, config, conversationId, agentId })
  },

  abortGoal: async (conversationId) => {
    if (!conversationId) return
    try {
      await window.eva.task.cancel(conversationId)
      set((state) => ({
        goalTasks: updateTask(state.goalTasks, conversationId, (task) => ({
          ...task,
          progress: task.progress ? markGoalProgressCancelled(task.progress) : null,
          isRunning: false,
          isPaused: false,
          recoveryStatus: 'cancelled',
        }), EMPTY_GOAL_TASK),
      }))
    } catch (error) {
      console.error('Failed to stop goal task:', error)
    }
  },

  pauseGoal: async (conversationId) => {
    if (!conversationId) return
    await window.eva.goal.pause(conversationId)
    set((state) => ({
      goalTasks: updateTask(state.goalTasks, conversationId, (task) => ({ ...task, isPaused: true }), EMPTY_GOAL_TASK),
    }))
  },

  resumeGoal: async (conversationId) => {
    if (!conversationId) return
    await window.eva.goal.resume(conversationId)
    set((state) => ({
      goalTasks: updateTask(state.goalTasks, conversationId, (task) => ({ ...task, isPaused: false }), EMPTY_GOAL_TASK),
    }))
  },

  clearGoalProgress: (conversationId) => {
    if (!conversationId) return
    set((state) => {
      const { [conversationId]: _removed, ...goalTasks } = state.goalTasks
      return { goalTasks }
    })
  },

  handleGoalEvent: (event) => {
    const conversationId = event.conversationId
    if (!conversationId) return

    set((state) => {
      const current = state.goalTasks[conversationId] || EMPTY_GOAL_TASK
      const progress = current.progress
      let next = current

      switch (event.type) {
        case 'goal_started':
          // A checkpointed continuation announces a new start event, but its
          // stored plan is still authoritative until the matching plan_created
          // event arrives. Clearing it here made resumed Goals look empty.
          if (progress?.steps.length) {
            next = {
              ...current,
              progress: { ...progress, goal: event.goal, status: 'in_progress', completedAt: undefined, conversationId },
              streamingContent: '', isRunning: true, isPaused: false,
            }
            break
          }
          next = {
            progress: { goal: event.goal, steps: [], currentStepIndex: 0, totalSteps: 0, status: 'in_progress', startedAt: Date.now(), conversationId },
            streamingContent: '', isRunning: true, isPaused: false,
          }
          break
        case 'plan_created':
          if (!progress) return state
          next = { ...current, progress: { ...progress, steps: event.steps, totalSteps: event.steps.length }, streamingContent: '' }
          break
        case 'step_started':
          if (!progress) return state
          next = {
            ...current,
            progress: { ...progress, currentStepIndex: event.stepIndex, steps: progress.steps.map((step) => step.id === event.stepId ? { ...step, status: 'in_progress' } : step) },
            streamingContent: '',
          }
          break
        case 'step_progress':
          next = { ...current, streamingContent: current.streamingContent + event.content }
          break
        case 'step_tool_call':
          if (!progress) return state
          next = { ...current, progress: { ...progress, steps: progress.steps.map((step) => step.id === event.stepId ? { ...step, toolCalls: [...(step.toolCalls || []), event.toolCall] } : step) } }
          break
        case 'step_tool_result':
          if (!progress) return state
          next = { ...current, progress: { ...progress, steps: progress.steps.map((step) => step.id === event.stepId ? { ...step, toolCalls: (step.toolCalls || []).map((call) => call.id === event.toolCallId ? { ...call, result: event.result, isError: event.isError } : call) } : step) } }
          break
        case 'step_completed':
        case 'step_failed':
          if (!progress) return state
          next = {
            ...current,
            progress: { ...progress, steps: progress.steps.map((step) => step.id === event.stepId ? { ...step, status: event.type === 'step_completed' ? 'completed' : 'failed', result: event.type === 'step_completed' ? event.result : event.error } : step) },
            streamingContent: '',
          }
          break
        case 'plan_adjusted':
          if (!progress) return state
          next = { ...current, progress: { ...progress, steps: [...progress.steps.filter((step) => step.status === 'completed' || step.status === 'failed'), ...event.steps] } }
          break
        case 'summary':
          if (!progress) return state
          next = { ...current, progress: { ...progress, summary: event.content } }
          break
        case 'done':
          next = { ...current, progress: { ...event.progress, conversationId }, isRunning: false, isPaused: false }
          break
        case 'error':
          next = { ...current, progress: progress ? markGoalProgressFailed(progress, event.error) : null, isRunning: false, isPaused: false }
          break
      }

      return { goalTasks: { ...state.goalTasks, [conversationId]: next } }
    })
  },

  hydrateSnapshot: (snapshot) => {
    if (!snapshot) return
    set((state) => {
      const isActive = snapshot.status === 'queued' || snapshot.status === 'running'
      const isPaused = snapshot.status === 'paused'
      if (snapshot.kind === 'expert') {
        return {
          expertTasks: {
            ...state.expertTasks,
            [snapshot.conversationId]: {
              currentPlan: snapshot.plan || null,
              isRunning: isActive,
              summary: snapshot.summary || snapshot.error || null,
              recoveryStatus: isActive ? undefined : snapshot.status,
            },
          },
        }
      }
      return {
        goalTasks: {
          ...state.goalTasks,
          [snapshot.conversationId]: {
            progress: snapshot.progress
              ? (() => {
                  const progress = snapshot.status === 'cancelled'
                    ? markGoalProgressCancelled(snapshot.progress)
                    : snapshot.status === 'failed'
                      ? markGoalProgressFailed(snapshot.progress, snapshot.error || 'Goal execution failed.')
                    : snapshot.progress
                  return {
                  ...progress,
                  // The durable scheduler state is authoritative after a
                  // conversation is re-opened. A saved in-progress plan must
                  // never be rendered as a failed Goal merely because the UI
                  // was remounted.
                  status: isActive || isPaused ? 'in_progress' : progress.status,
                }
              })()
              : null,
            streamingContent: '',
            isRunning: isActive,
            isPaused,
            recoveryStatus: isActive || isPaused ? undefined : snapshot.status,
          },
        },
      }
    })
  },
}))
