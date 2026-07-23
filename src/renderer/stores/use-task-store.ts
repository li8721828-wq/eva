import { create } from 'zustand'
import type { TaskPlan, SubTask, GoalProgress, TeamEvent, GoalConfig } from '../../shared/types'
import type { GoalEvent } from '../lib/goal-event'

interface TaskState {
  currentPlan: TaskPlan | null
  goalProgress: GoalProgress | null
  isTaskRunning: boolean
  summary: string | null

  // Goal mode state
  goalStreamingContent: string
  isGoalRunning: boolean
  isGoalPaused: boolean

  setCurrentPlan: (plan: TaskPlan | null) => void
  setGoalProgress: (progress: GoalProgress | null) => void
  setTaskRunning: (running: boolean) => void
  updateSubTask: (subtaskId: string, updates: Partial<SubTask>) => void
  clearPlan: () => void
  clearGoalProgress: () => void
  handleTeamEvent: (event: TeamEvent) => void
  startExpertTask: (goal: string, conversationId?: string) => Promise<void>
  abortExpertTask: (conversationId?: string) => Promise<void>

  // Goal mode methods
  startGoal: (goal: string, agentId: string, conversationId: string, config?: Partial<GoalConfig>) => void
  abortGoal: () => void
  pauseGoal: () => void
  resumeGoal: () => void
  handleGoalEvent: (event: GoalEvent) => void
}

export const useTaskStore = create<TaskState>((set) => ({
  currentPlan: null,
  goalProgress: null,
  isTaskRunning: false,
  summary: null,
  goalStreamingContent: '',
  isGoalRunning: false,
  isGoalPaused: false,

  setCurrentPlan: (plan) => set({ currentPlan: plan }),
  setGoalProgress: (progress) => set({ goalProgress: progress }),
  setTaskRunning: (running) => set({ isTaskRunning: running }),

  updateSubTask: (subtaskId, updates) =>
    set((s) => {
      if (!s.currentPlan) return {}
      return {
        currentPlan: {
          ...s.currentPlan,
          subtasks: s.currentPlan.subtasks.map((st) =>
            st.id === subtaskId ? { ...st, ...updates } : st
          ),
        },
      }
    }),

  clearPlan: () => set({ currentPlan: null, summary: null }),
  clearGoalProgress: () => set({ goalProgress: null }),

  handleTeamEvent: (event) => {
    switch (event.type) {
      case 'plan_created':
        if (event.plan) set({ currentPlan: event.plan, isTaskRunning: true, summary: null })
        break

      case 'task_created':
        // Plan is being created, nothing specific to update yet
        break

      case 'task_assigned':
        if (event.subtaskId && event.agentName) {
          const state = useTaskStore.getState()
          state.updateSubTask(event.subtaskId, {
            assignedAgentId: event.agentId,
            assignedAgentName: event.agentName,
            status: 'in_progress',
          })
        }
        break

      case 'task_progress':
        if (event.subtaskId && event.progress) {
          const state = useTaskStore.getState()
          state.updateSubTask(event.subtaskId, {
            status: 'in_progress',
            result: event.progress,
          })
        }
        break

      case 'task_completed':
        if (event.subtaskId) {
          const state = useTaskStore.getState()
          state.updateSubTask(event.subtaskId, {
            status: 'completed',
            result: event.result,
            completedAt: Date.now(),
          })
        }
        break

      case 'task_failed':
        if (event.subtaskId) {
          const state = useTaskStore.getState()
          state.updateSubTask(event.subtaskId, {
            status: 'failed',
            result: event.error,
            completedAt: Date.now(),
          })
        }
        break

      case 'summary':
        set({ summary: event.summary || null })
        break

      case 'done':
        set({ isTaskRunning: false })
        break

      case 'error':
        set({ isTaskRunning: false })
        break
    }
  },

  startExpertTask: async (goal: string, conversationId?: string) => {
    set({ isTaskRunning: true, summary: null, currentPlan: null })
    try {
      let convId = conversationId
      if (!convId) {
        // Create an expert mode conversation
        const conv = await window.eva.conversation.create({
          title: `Expert: ${goal.slice(0, 60)}`,
          mode: 'expert',
        })
        convId = conv.id
      }
      await window.eva.task.start(convId, goal)
    } catch (err) {
      console.error('Failed to start expert task:', err)
      set({ isTaskRunning: false })
    }
  },

  abortExpertTask: async (conversationId?: string) => {
    const convId = conversationId || ''
    try {
      await window.eva.task.abort(convId)
      set({ isTaskRunning: false })
    } catch (err) {
      console.error('Failed to abort expert task:', err)
    }
  },

  // ─── Goal Mode ─────────────────────────────────────────────────────────────

  startGoal: (goal, agentId, conversationId, config?) => {
    set({ isGoalRunning: true, isGoalPaused: false, goalStreamingContent: '', goalProgress: null })
    window.eva.goal.start({ goal, config, conversationId, agentId })
  },

  abortGoal: () => {
    window.eva.goal.abort()
    set({ isGoalRunning: false, isGoalPaused: false })
  },

  pauseGoal: () => {
    window.eva.goal.pause()
    set({ isGoalPaused: true })
  },

  resumeGoal: () => {
    window.eva.goal.resume()
    set({ isGoalPaused: false })
  },

  handleGoalEvent: (event) => {
    const state = useTaskStore.getState()
    const progress = state.goalProgress

    switch (event.type) {
      case 'plan_created':
        set({
          goalProgress: {
            goal: progress?.goal || '',
            steps: event.steps,
            currentStepIndex: 0,
            totalSteps: event.steps?.length || 0,
            status: 'in_progress' as const,
            startedAt: Date.now(),
          },
          goalStreamingContent: '',
        })
        break

      case 'step_started':
        if (progress) {
          const updatedSteps = progress.steps.map((s) =>
            s.id === event.stepId ? { ...s, status: 'in_progress' as const } : s
          )
          set({
            goalProgress: { ...progress, steps: updatedSteps, currentStepIndex: event.stepIndex },
            goalStreamingContent: '',
          })
        }
        break

      case 'step_progress':
        set((s) => ({
          goalStreamingContent: s.goalStreamingContent + event.content,
        }))
        break

      case 'step_completed':
        if (progress) {
          const updatedSteps = progress.steps.map((s) =>
            s.id === event.stepId ? { ...s, status: 'completed' as const, result: event.result } : s
          )
          const completedCount = updatedSteps.filter((s) => s.status === 'completed').length
          set({
            goalProgress: { ...progress, steps: updatedSteps, totalSteps: updatedSteps.length },
            goalStreamingContent: '',
          })
        }
        break

      case 'step_failed':
        if (progress) {
          const updatedSteps = progress.steps.map((s) =>
            s.id === event.stepId ? { ...s, status: 'failed' as const, result: event.error } : s
          )
          set({
            goalProgress: { ...progress, steps: updatedSteps },
            goalStreamingContent: '',
          })
        }
        break

      case 'plan_adjusted':
        if (progress) {
          const completedSteps = progress.steps.filter((s) => s.status === 'completed' || s.status === 'failed')
          const updatedSteps = [...completedSteps, ...event.steps]
          set({
            goalProgress: { ...progress, steps: updatedSteps },
          })
        }
        break

      case 'summary':
        if (progress) {
          set({
            goalProgress: { ...progress, summary: event.content },
          })
        }
        break

      case 'done':
        set({
          goalProgress: event.progress,
          isGoalRunning: false,
          isGoalPaused: false,
        })
        break

      case 'error':
        if (progress) {
          set({
            goalProgress: { ...progress, status: 'failed' },
            isGoalRunning: false,
            isGoalPaused: false,
          })
        }
        break
    }
  },
}))
