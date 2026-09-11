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
    // Keep the provider request genuinely streaming, but release text to the
    // renderer one Unicode character at a time. This prevents a gateway-sized
    // delta from causing several visual lines to appear in one repaint.
    const CHARACTER_INTERVAL_MS = 42
    const FINAL_INK_SETTLE_MS = 230
    type QueuedStreamItem =
      | { kind: 'text'; conversationId: string; content: string }
      | { kind: 'event'; event: ChatStreamEvent }
      | { kind: 'terminal'; event: ChatStreamEvent }
    const pendingItems: QueuedStreamItem[] = []
    let flushTimer: number | null = null

    const clearFlushTimer = () => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
    }

    const drainQueue = () => {
      flushTimer = null
      const item = pendingItems[0]
      if (!item) return

      if (item.kind === 'text') {
        const character = Array.from(item.content)[0]
        if (!character) {
          pendingItems.shift()
          flushTimer = window.setTimeout(drainQueue, 0)
          return
        }
        item.content = item.content.slice(character.length)
        useChatStore.getState().appendStreamEvent({ type: 'text_delta', conversationId: item.conversationId, content: character })
        if (!item.content) pendingItems.shift()
        flushTimer = window.setTimeout(drainQueue, CHARACTER_INTERVAL_MS)
        return
      }

      pendingItems.shift()
      if (item.kind === 'terminal') {
        flushTimer = window.setTimeout(() => {
          flushTimer = null
          useChatStore.getState().appendStreamEvent(item.event)
          drainQueue()
        }, FINAL_INK_SETTLE_MS)
        return
      }

      useChatStore.getState().appendStreamEvent(item.event)
      flushTimer = window.setTimeout(drainQueue, 0)
    }

    const scheduleQueueDrain = () => {
      if (flushTimer !== null || pendingItems.length === 0) return
      flushTimer = window.setTimeout(drainQueue, 0)
    }

    const flushPendingItems = () => {
      clearFlushTimer()
      while (pendingItems.length > 0) {
        const item = pendingItems.shift()!
        if (item.kind === 'text') {
          useChatStore.getState().appendStreamEvent({ type: 'text_delta', conversationId: item.conversationId, content: item.content })
        } else {
          useChatStore.getState().appendStreamEvent(item.event)
        }
      }
    }

    // Listen for chat stream events
    const cleanupChat = window.eva.chat.onStream((_event, data) => {
      const streamEvent = data as unknown as ChatStreamEvent
      if (streamEvent.type === 'text_delta' && streamEvent.content) {
        if (!streamEvent.conversationId) return
        pendingItems.push({ kind: 'text', conversationId: streamEvent.conversationId, content: streamEvent.content })
        scheduleQueueDrain()
        return
      }

      // Preserve event ordering: any text preceding a tool call, completion,
      // or error is committed before that structural event is applied.
      if (streamEvent.type === 'done' && streamEvent.conversationId) {
        const conversationId = streamEvent.conversationId
        // Some providers repeat the complete answer in the done event. Queue
        // only the suffix not already represented by emitted and queued text.
        const current = useChatStore.getState().streamingByConversation[conversationId]?.content || ''
        const queued = current + pendingItems
          .filter((item): item is Extract<QueuedStreamItem, { kind: 'text' }> => item.kind === 'text' && item.conversationId === conversationId)
          .map((item) => item.content)
          .join('')
        const finalContent = streamEvent.content || ''
        if (finalContent.startsWith(queued)) {
          const suffix = finalContent.slice(queued.length)
          if (suffix) pendingItems.push({ kind: 'text', conversationId, content: suffix })
        }
        pendingItems.push({ kind: 'terminal', event: { ...streamEvent, content: '' } })
        scheduleQueueDrain()
        return
      }

      pendingItems.push({ kind: 'event', event: streamEvent })
      scheduleQueueDrain()
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
      flushPendingItems()
      cleanupChat()
      cleanupTask()
      cleanupGoal()
      cleanupSymposium()
    }
  }, [])
}
