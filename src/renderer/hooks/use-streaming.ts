import { useEffect } from 'react'
import { isStreamedTextRendered, useChatStore } from '@/stores/use-chat-store'
import { useTaskStore } from '@/stores/use-task-store'
import type { ChatStreamEvent } from '../../shared/types'
import type { TeamEvent } from '../../shared/types'
import type { GoalEvent } from '@/lib/goal-event'
import type { SymposiumStreamEvent } from '../../shared/types/symposium'
import { useSymposiumStore } from '@/stores/use-symposium-store'
import {
  enqueueStreamItem,
  flushRevealQueue,
  queuedTextFor,
  setRevealPacingCheck,
  setRevealSink,
} from '@/lib/stream-reveal-queue'

/**
 * Hook to set up streaming event listeners from the main process.
 * Should be called once at the App level.
 */
export function useStreaming(): void {
  useEffect(() => {
    setRevealSink((event) => useChatStore.getState().appendStreamEvent(event))
    // Pacing only makes visible text appear gradually. When the transcript is
    // not rendering the in-flight text at all (its reply row already shows the
    // same content), pacing would delay the terminal event behind an animation
    // nobody can see, so those characters are released in one delta.
    setRevealPacingCheck((conversationId) => (
      isStreamedTextRendered(useChatStore.getState(), conversationId)
    ))

    // Listen for chat stream events
    const cleanupChat = window.eva.chat.onStream((_event, data) => {
      const streamEvent = data as unknown as ChatStreamEvent
      if (streamEvent.type === 'text_delta' && streamEvent.content) {
        if (!streamEvent.conversationId) return
        enqueueStreamItem({ kind: 'text', conversationId: streamEvent.conversationId, content: streamEvent.content })
        return
      }

      // Preserve event ordering: any text preceding a tool call, completion,
      // or error is committed before that structural event is applied.
      if (streamEvent.type === 'done' && streamEvent.conversationId) {
        const conversationId = streamEvent.conversationId
        // Some providers repeat the complete answer in the done event. Queue
        // only the suffix not already represented by emitted and queued text.
        const current = useChatStore.getState().streamingByConversation[conversationId]?.content || ''
        const queued = current + queuedTextFor(conversationId)
        const finalContent = streamEvent.content || ''
        if (finalContent.startsWith(queued)) {
          const suffix = finalContent.slice(queued.length)
          if (suffix) enqueueStreamItem({ kind: 'text', conversationId, content: suffix })
        }
        enqueueStreamItem({ kind: 'terminal', event: { ...streamEvent, content: '' } })
        return
      }

      enqueueStreamItem({ kind: 'event', event: streamEvent })
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
      flushRevealQueue()
      cleanupChat()
      cleanupTask()
      cleanupGoal()
      cleanupSymposium()
    }
  }, [])
}
