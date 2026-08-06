import React, { useRef, useEffect, useLayoutEffect, useState, useMemo, useCallback } from 'react'
import type { ChatMessage } from '../../../shared/types'
import { useChatStore } from '@/stores/use-chat-store'
import { ScrollArea } from '@/components/ui/ScrollArea'
import { MessageBubble } from './MessageBubble'
import { ToolCallView } from './ToolCallView'
import { GoalExecutionCard } from './GoalExecutionCard'
import { WelcomeScreen } from './WelcomeScreen'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/use-app-store'
import { useTaskStore } from '@/stores/use-task-store'

const PAGE_SIZE = 100
const conversationScrollOffsets = new Map<string, number>()
const SCROLL_FOLLOW_THRESHOLD = 72
const SMOOTH_SPIN_CLASS = 'animate-spin'
const ESTIMATED_MESSAGE_HEIGHT = 180
const VIRTUAL_OVERSCAN = 900

type RenderItem =
  | { id: string; kind: 'message'; message: ChatMessage }
  | { id: string; kind: 'goal' }

function GoalMark() {
  return (
    <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-50 text-violet-600" aria-hidden="true">
      <span className="absolute h-5 w-5 rounded-full border border-violet-300/90" />
      <span className="relative z-10 h-2.5 w-2.5 rounded-full bg-violet-600 shadow-[0_0_0_2px_rgba(221,214,254,0.9)]" />
      <span className="absolute left-[5px] top-[7px] h-1.5 w-1.5 rounded-full border border-violet-300 bg-white shadow-sm" />
      <span className="absolute bottom-[5px] right-[6px] h-1.5 w-1.5 rounded-full border border-violet-300 bg-white shadow-sm" />
    </div>
  )
}

export interface MessageListProps {
  className?: string
}

export function MessageList({ className }: MessageListProps) {
  const { messages, currentConversationId, isConversationLoading, isStreaming, streamingContent, streamingToolCalls, streamingStatus } = useChatStore()
  const { rightPanelVisible } = useAppStore()
  const isTeamRunning = useTaskStore((state) => Boolean(currentConversationId && state.expertTasks[currentConversationId]?.isRunning))
  const goalTask = useTaskStore((state) => currentConversationId ? state.goalTasks[currentConversationId] : undefined)
  const hasGoalProgress = Boolean(goalTask?.progress?.conversationId === currentConversationId)
  const isGoalRunning = Boolean(goalTask?.isRunning)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const previousMessageCountRef = useRef(messages.length)
  const pendingRestoreRef = useRef<string | null>(currentConversationId)
  const followStreamRef = useRef(true)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(800)
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({})
  const itemElementsRef = useRef(new Map<string, HTMLDivElement>())
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const scrollToBottom = (behavior: ScrollBehavior) => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return false
    scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior })
    setScrollTop(Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight))
    return true
  }

  const saveScrollPosition = () => {
    const scrollArea = scrollAreaRef.current
    if (!currentConversationId || !scrollArea) return
    conversationScrollOffsets.set(currentConversationId, scrollArea.scrollTop)
  }

  const handleScroll = () => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return

    saveScrollPosition()
    setScrollTop(scrollArea.scrollTop)
    setViewportHeight(scrollArea.clientHeight)
    followStreamRef.current = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight <= SCROLL_FOLLOW_THRESHOLD
  }

  // Keep older history out of the DOM until requested. The current page is
  // virtualized again below, so a large Markdown response does not make all
  // of its neighbors expensive to render.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
    setMeasuredHeights({})
    setScrollTop(0)
  }, [currentConversationId])

  // Tool-role messages are retained for a valid model tool-call history, but
  // their full output is already available from the preceding tool card.
  // Rendering them as chat bubbles duplicates large search/page results.
  const renderableMessages = useMemo(() => messages.filter((message) => message.role !== 'tool'), [messages])

  const visibleMessages = useMemo(() => {
    return renderableMessages.length <= visibleCount
      ? renderableMessages
      : renderableMessages.slice(renderableMessages.length - visibleCount)
  }, [renderableMessages, visibleCount])

  const hasMore = renderableMessages.length > visibleCount
  const goalInsertAfterIndex = useMemo(() => {
    if (!hasGoalProgress || !goalTask?.progress) return -1

    let index = -1
    for (let messageIndex = 0; messageIndex < visibleMessages.length; messageIndex += 1) {
      if (visibleMessages[messageIndex].timestamp <= goalTask.progress.startedAt) {
        index = messageIndex
      }
    }
    return index
  }, [goalTask?.progress, hasGoalProgress, visibleMessages])

  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = visibleMessages.map((message) => ({
      id: `message-${message.id}`,
      kind: 'message',
      message,
    }))

    if (!hasGoalProgress) return items

    const goalItem: RenderItem = { id: `goal-${currentConversationId || 'current'}`, kind: 'goal' }
    const insertAt = goalInsertAfterIndex < 0 ? 0 : goalInsertAfterIndex + 1
    items.splice(insertAt, 0, goalItem)
    return items
  }, [currentConversationId, goalInsertAfterIndex, hasGoalProgress, visibleMessages])

  const itemLayout = useMemo(() => {
    const offsets: number[] = []
    let totalHeight = 0
    for (const item of renderItems) {
      offsets.push(totalHeight)
      totalHeight += measuredHeights[item.id] ?? ESTIMATED_MESSAGE_HEIGHT
    }
    return { offsets, totalHeight }
  }, [measuredHeights, renderItems])

  const virtualRange = useMemo(() => {
    if (renderItems.length === 0) return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0 }

    const startBoundary = Math.max(0, scrollTop - VIRTUAL_OVERSCAN)
    const endBoundary = scrollTop + viewportHeight + VIRTUAL_OVERSCAN
    let start = 0
    while (
      start < renderItems.length - 1
      && itemLayout.offsets[start] + (measuredHeights[renderItems[start].id] ?? ESTIMATED_MESSAGE_HEIGHT) < startBoundary
    ) {
      start += 1
    }

    let end = start
    while (
      end < renderItems.length
      && itemLayout.offsets[end] < endBoundary
    ) {
      end += 1
    }

    return {
      start,
      end: Math.max(start + 1, end),
      topSpacer: itemLayout.offsets[start] ?? 0,
      bottomSpacer: Math.max(0, itemLayout.totalHeight - (itemLayout.offsets[Math.max(start + 1, end)] ?? itemLayout.totalHeight)),
    }
  }, [itemLayout, measuredHeights, renderItems, scrollTop, viewportHeight])

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setMeasuredHeights((previous) => {
        let changed = false
        const next = { ...previous }
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageItemId
          if (!id) continue
          const height = Math.ceil(entry.contentRect.height)
          if (height > 0 && next[id] !== height) {
            next[id] = height
            changed = true
          }
        }
        return changed ? next : previous
      })
    })
    resizeObserverRef.current = observer
    itemElementsRef.current.forEach((element) => observer.observe(element))
    return () => {
      observer.disconnect()
      resizeObserverRef.current = null
    }
  }, [])

  const attachItemRef = useCallback((id: string, element: HTMLDivElement | null) => {
    const previousElement = itemElementsRef.current.get(id)
    if (previousElement && previousElement !== element) {
      resizeObserverRef.current?.unobserve(previousElement)
      itemElementsRef.current.delete(id)
    }
    if (element) {
      itemElementsRef.current.set(id, element)
      resizeObserverRef.current?.observe(element)
    }
  }, [])

  useLayoutEffect(() => {
    // Capture the outgoing conversation before its scroll area unmounts.
    return () => saveScrollPosition()
  }, [currentConversationId])

  useLayoutEffect(() => {
    pendingRestoreRef.current = currentConversationId
    previousMessageCountRef.current = 0
  }, [currentConversationId])

  useLayoutEffect(() => {
    const conversationId = pendingRestoreRef.current
    const scrollArea = scrollAreaRef.current
    if (!conversationId || conversationId !== currentConversationId || !scrollArea) return

    // Conversation messages arrive asynchronously. Wait until the scrollable
    // surface exists, then restore the saved reading position in one frame.
    // Conversation selection clears the old message list while IPC loads the
    // next one. Restoring against that empty surface would lock it at the top.
    if (isConversationLoading) return

    const savedOffset = conversationScrollOffsets.get(conversationId)
    const frame = requestAnimationFrame(() => {
      const area = scrollAreaRef.current
      if (!area || pendingRestoreRef.current !== conversationId) return

      if (savedOffset === undefined) {
        area.scrollTop = area.scrollHeight
      } else {
        area.scrollTop = Math.min(savedOffset, Math.max(0, area.scrollHeight - area.clientHeight))
      }

      setScrollTop(area.scrollTop)
      setViewportHeight(area.clientHeight)
      followStreamRef.current = area.scrollHeight - area.scrollTop - area.clientHeight <= SCROLL_FOLLOW_THRESHOLD
      previousMessageCountRef.current = messages.length
      pendingRestoreRef.current = null
    })

    return () => cancelAnimationFrame(frame)
  }, [currentConversationId, isConversationLoading, messages.length])

  useLayoutEffect(() => {
    const previousMessageCount = previousMessageCountRef.current
    previousMessageCountRef.current = messages.length

    // Persisted conversation refreshes replace the array even when no message
    // was added. Only follow genuine new messages, and never pull a reader
    // away from the position they intentionally scrolled to.
    if (
      pendingRestoreRef.current === currentConversationId ||
      messages.length <= previousMessageCount ||
      !followStreamRef.current
    ) return

    scrollToBottom('auto')
  }, [currentConversationId, messages])

  useEffect(() => {
    // Streaming updates can arrive many times per second. An immediate follow
    // keeps the newest content visible without replaying a long smooth scroll.
    if (isStreaming && followStreamRef.current) scrollToBottom('auto')
  }, [isStreaming, streamingContent, streamingToolCalls])

  if (messages.length === 0 && !isConversationLoading && !isStreaming && !isTeamRunning && !hasGoalProgress) {
    return <WelcomeScreen className={className} />
  }

  return (
    <ScrollArea ref={scrollAreaRef} onScroll={handleScroll} className={cn('flex-1', className)}>
      <div
        className={cn(
          'flex w-full flex-col px-12 py-10',
          rightPanelVisible && 'mx-auto max-w-4xl'
        )}
      >
        {/* Load more button for long conversations */}
        {hasMore && (
          <div className="flex justify-center py-2">
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-50 transition-all duration-200"
            >
              Load earlier messages ({renderableMessages.length - visibleCount} more)
            </button>
          </div>
        )}

        {virtualRange.topSpacer > 0 && <div aria-hidden="true" style={{ height: virtualRange.topSpacer }} />}

        {renderItems.slice(virtualRange.start, virtualRange.end).map((item) => (
          <div
            key={item.id}
            ref={(element) => attachItemRef(item.id, element)}
            data-message-item-id={item.id}
            className="pb-9"
          >
            {item.kind === 'message' ? (
              <MessageBubble message={item.message} />
            ) : (
              <article className="flex items-start gap-3">
                <GoalMark />
                <GoalExecutionCard conversationId={currentConversationId} />
              </article>
            )}
          </div>
        ))}

        {virtualRange.bottomSpacer > 0 && <div aria-hidden="true" style={{ height: virtualRange.bottomSpacer }} />}

        {isStreaming && (
          <div className="flex items-center gap-2 px-0 py-1 text-sm text-zinc-500">
            <Loader2 className={cn('h-4 w-4 text-violet-500', SMOOTH_SPIN_CLASS)} />
            <span>{streamingStatus || 'Working...'}</span>
          </div>
        )}

        {isTeamRunning && (
          <div className="flex items-center gap-2 px-0 py-1 text-sm text-zinc-500">
            <Loader2 className={cn('h-4 w-4 text-violet-500', SMOOTH_SPIN_CLASS)} />
            <span>Expert Team is planning and assigning work...</span>
          </div>
        )}

        {/* Streaming tool calls */}
        {isStreaming && streamingToolCalls.length > 0 && (
          <div className="px-0 py-2">
            {streamingToolCalls.map((tc) => (
              <ToolCallView key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {/* Render the in-flight Markdown through the same assistant-message surface.
            ReactMarkdown tolerates incomplete syntax and progressively settles as
            subsequent chunks arrive. */}
        {isStreaming && streamingContent && (
          <MessageBubble
            isStreaming
            message={{
              id: `streaming-${currentConversationId || 'message'}`,
              conversationId: currentConversationId || '',
              role: 'assistant',
              content: streamingContent,
              timestamp: Date.now(),
            }}
          />
        )}
      </div>
    </ScrollArea>
  )
}
