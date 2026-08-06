import { useEffect } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useTaskStore } from '@/stores/use-task-store'
import type { ChatStreamEvent } from '../../shared/types'
import type { TeamEvent } from '../../shared/types'
import type { GoalEvent } from '@/lib/goal-event'
import type { SymposiumStreamEvent } from '../../shared/types/symposium'
import { useSymposiumStore } from '@/stores/use-symposium-store'

/**
 * Hook to set up streaming event listeners from the main process.
 * Should be called once at the App level.
 */
export function useStreaming(): void {
  useEffect(() => {
    // Providers frequently emit very small token chunks. Rendering Markdown for
    // every chunk is expensive, especially for longer responses, so coalesce
    // visual updates to a stable ~30fps without delaying tool/status events.
    let pendingConversationId: string | null = null
    let pendingText = ''
    let flushTimer: number | null = null

    const flushPendingText = () => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }

      const conversationId = pendingConversationId
      const content = pendingText
      pendingConversationId = null
      pendingText = ''

      if (!conversationId || !content) return
      if (conversationId !== useChatStore.getState().currentConversationId) return

      useChatStore.getState().appendStreamEvent({
        type: 'text_delta',
        conversationId,
        content,
      })
    }

    const scheduleTextFlush = () => {
      if (flushTimer !== null) return
      flushTimer = window.setTimeout(flushPendingText, 33)
    }

    // Listen for chat stream events
    const cleanupChat = window.eva.chat.onStream((_event, data) => {
      const streamEvent = data as unknown as ChatStreamEvent
      // The chat surface has one visible stream. Events for a background
      // conversation are persisted by the main process and loaded on return.
      if (streamEvent.conversationId !== useChatStore.getState().currentConversationId) return

      if (streamEvent.type === 'text_delta' && streamEvent.content) {
        if (pendingConversationId && pendingConversationId !== streamEvent.conversationId) {
          flushPendingText()
        }
        pendingConversationId = streamEvent.conversationId
        pendingText += streamEvent.content
        scheduleTextFlush()
        return
      }

      // Preserve event ordering: any text preceding a tool call, completion,
      // or error is committed before that structural event is applied.
      flushPendingText()
      useChatStore.getState().appendStreamEvent(streamEvent)
    })

    // Listen for task stream events (expert mode)
    const cleanupTask = window.eva.task.onStream((_event, data) => {
      const teamEvent = data as unknown as TeamEvent
      useTaskStore.getState().handleTeamEvent(teamEvent)
      if (teamEvent.type === 'error' && teamEvent.error) {
        useChatStore.getState().setError(`Expert Team: ${teamEvent.error}`)
      }
    })

    // Listen for goal stream events
    const cleanupGoal = window.eva.goal.onStream((_event, data) => {
      const goalEvent = data as unknown as GoalEvent
      useTaskStore.getState().handleGoalEvent(goalEvent)
    })

    const cleanupSymposium = window.eva.symposium.onStream((_event, data) => {
      useSymposiumStore.getState().handleEvent(data as SymposiumStreamEvent)
    })

    return () => {
      flushPendingText()
      cleanupChat()
      cleanupTask()
      cleanupGoal()
      cleanupSymposium()
    }
  }, [])
}
