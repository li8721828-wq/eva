import { useEffect } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useTaskStore } from '@/stores/use-task-store'
import type { ChatStreamEvent } from '../../shared/types'
import type { TeamEvent } from '../../shared/types'
import type { GoalEvent } from '@/lib/goal-event'

/**
 * Hook to set up streaming event listeners from the main process.
 * Should be called once at the App level.
 */
export function useStreaming(): void {
  useEffect(() => {
    // Listen for chat stream events
    const cleanupChat = window.eva.chat.onStream((_event, data) => {
      const streamEvent = data as unknown as ChatStreamEvent
      useChatStore.getState().appendStreamEvent(streamEvent)
    })

    // Listen for task stream events (expert mode)
    const cleanupTask = window.eva.task.onStream((_event, data) => {
      const teamEvent = data as unknown as TeamEvent
      useTaskStore.getState().handleTeamEvent(teamEvent)
    })

    // Listen for goal stream events
    const cleanupGoal = window.eva.goal.onStream((_event, data) => {
      const goalEvent = data as unknown as GoalEvent
      useTaskStore.getState().handleGoalEvent(goalEvent)
    })

    return () => {
      cleanupChat()
      cleanupTask()
      cleanupGoal()
    }
  }, [])
}
