import React, { useRef, useEffect, useLayoutEffect, useState, useMemo, useCallback } from 'react'
import type { ChatMessage, ChatUsage } from '../../../shared/types'
import { useChatStore } from '@/stores/use-chat-store'
import { ScrollArea } from '@/components/ui/ScrollArea'
import { MarkdownMessageContent, MessageBubble } from './MessageBubble'
import { RequirementClarificationCard } from './RequirementClarificationCard'
import { WelcomeScreen } from './WelcomeScreen'
import { CheckCircle2, ChevronsDown, CircleAlert, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/use-app-store'
import { useTaskStore } from '@/stores/use-task-store'
import type { RequirementClarificationAnswer, RequirementRun } from '../../../shared/types/requirement-engineering'

const PAGE_SIZE = 100
const CONVERSATION_SCROLL_STORAGE_KEY = 'eva.conversation-scroll-positions.v2'
const MAX_SAVED_SCROLL_POSITIONS = 200
const conversationScrollOffsets = new Map<string, number>()
const SCROLL_FOLLOW_THRESHOLD = 72
const SMOOTH_SPIN_CLASS = 'animate-spin'
const ESTIMATED_MESSAGE_HEIGHT = 180
const VIRTUAL_OVERSCAN = 900
const VIRTUAL_SCROLL_UPDATE_THRESHOLD = 80
const SCROLL_AFFORDANCE_UPDATE_INTERVAL = 80
const JUMP_TO_BOTTOM_THRESHOLD = 240

type ScrollIndicator = { top: number; height: number }

type RenderItem = { id: string; kind: 'message'; message: ChatMessage }

function RequirementElapsedTime({ startedAt }: { startedAt: number }) {
  const getElapsedSeconds = () => Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const [elapsed, setElapsed] = useState(getElapsedSeconds)

  useEffect(() => {
    const updateElapsed = () => setElapsed(getElapsedSeconds())
    updateElapsed()
    const timer = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])

  return <span className="ml-auto text-xs font-normal tabular-nums text-zinc-500">已运行 {elapsed}s</span>
}

function loadSavedScrollPositions() {
  if (typeof window === 'undefined') return

  try {
    const saved = window.localStorage.getItem(CONVERSATION_SCROLL_STORAGE_KEY)
    if (!saved) return

    const parsed = JSON.parse(saved) as Record<string, unknown>
    for (const [conversationId, offset] of Object.entries(parsed)) {
      if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) {
        conversationScrollOffsets.set(conversationId, offset)
      }
    }
  } catch {
    // Scroll restoration is optional; an invalid saved value should not affect chat rendering.
  }
}

function persistScrollPositions() {
  if (typeof window === 'undefined') return

  try {
    const entries = Array.from(conversationScrollOffsets.entries()).slice(-MAX_SAVED_SCROLL_POSITIONS)
    window.localStorage.setItem(CONVERSATION_SCROLL_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Ignore unavailable storage (for example, a restrictive browser profile).
  }
}

function rememberScrollPosition(conversationId: string, offset: number, persist = false) {
  conversationScrollOffsets.set(conversationId, Math.max(0, offset))
  if (persist) persistScrollPositions()
}

loadSavedScrollPositions()

function sumConversationUsage(messages: ChatMessage[]): ChatUsage | undefined {
  const usageMessages = messages.filter((message) => message.role === 'assistant' && message.usage)
  if (usageMessages.length === 0) return undefined

  return usageMessages.reduce<ChatUsage>((total, message) => {
    const usage = message.usage!
    return {
      promptTokens: total.promptTokens + usage.promptTokens,
      completionTokens: total.completionTokens + usage.completionTokens,
      cachedTokens: (total.cachedTokens || 0) + (usage.cachedTokens || 0),
      cacheMissTokens: (total.cacheMissTokens || 0) + (usage.cacheMissTokens || 0),
      estimatedCostCny: (total.estimatedCostCny || 0) + (usage.estimatedCostCny || 0),
      estimatedCost: total.estimatedCostCurrency === usage.estimatedCostCurrency
        ? (total.estimatedCost || 0) + (usage.estimatedCost || 0)
        : total.estimatedCost ?? usage.estimatedCost,
      estimatedCostCurrency: total.estimatedCostCurrency || usage.estimatedCostCurrency,
      providerReportedCost: total.providerReportedCurrency === usage.providerReportedCurrency
        ? (total.providerReportedCost || 0) + (usage.providerReportedCost || 0)
        : undefined,
      providerReportedCurrency: total.providerReportedCurrency || usage.providerReportedCurrency,
      modelCalls: (total.modelCalls || 0) + (usage.modelCalls || 1),
    }
  }, { promptTokens: 0, completionTokens: 0 })
}

export interface MessageListProps {
  className?: string
}

export function MessageList({ className }: MessageListProps) {
  const { messages, currentConversationId, isConversationLoading, streamingByConversation, requirementProgressByConversation } = useChatStore()
  const stream = currentConversationId ? streamingByConversation[currentConversationId] : undefined
  const isStreaming = Boolean(stream?.isStreaming)
  const streamingContent = stream?.content || ''
  const streamingReasoningContent = stream?.reasoningContent || ''
  const requirementProgress = currentConversationId ? requirementProgressByConversation[currentConversationId] : undefined
  const isRequirementRunning = Boolean(requirementProgress)
  const { rightPanelVisible, rightPanelWidth, language } = useAppStore()
  const isTeamRunning = useTaskStore((state) => Boolean(currentConversationId && state.expertTasks[currentConversationId]?.isRunning))
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const activeConversationIdRef = useRef<string | null>(currentConversationId)
  const previousMessageCountRef = useRef(messages.length)
  const pendingRestoreRef = useRef<string | null>(currentConversationId)
  const scrollPersistTimerRef = useRef<number | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const lastScrollAffordanceUpdateAtRef = useRef(0)
  const followStreamRef = useRef(true)
  const lastScrollTopRef = useRef(currentConversationId ? conversationScrollOffsets.get(currentConversationId) ?? 0 : 0)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(800)
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({})
  const itemElementsRef = useRef(new Map<string, HTMLDivElement>())
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const scrollIndicatorTimerRef = useRef<number | null>(null)
  const [scrollIndicatorVisible, setScrollIndicatorVisible] = useState(false)
  const [scrollIndicator, setScrollIndicator] = useState<ScrollIndicator>({ top: 0, height: 100 })
  const [canJumpToBottom, setCanJumpToBottom] = useState(false)
  const [awaitingClarification, setAwaitingClarification] = useState<RequirementRun | null>(null)
  const [awaitingSpecResolution, setAwaitingSpecResolution] = useState<RequirementRun | null>(null)

  const loadAwaitingClarification = useCallback(async () => {
    if (!currentConversationId) {
      setAwaitingClarification(null)
      setAwaitingSpecResolution(null)
      return
    }
    try {
      const runs = await window.eva.requirements.listRuns(currentConversationId)
      setAwaitingClarification(runs.find((run) => run.status === 'awaiting-clarification') || null)
      setAwaitingSpecResolution(runs.find((run) => run.status === 'awaiting-spec-resolution') || null)
    } catch {
      setAwaitingClarification(null)
      setAwaitingSpecResolution(null)
    }
  }, [currentConversationId])

  useEffect(() => {
    void loadAwaitingClarification()
  }, [loadAwaitingClarification, messages.length, requirementProgress])

  const submitClarificationAnswers = useCallback(async (answers: RequirementClarificationAnswer[]) => {
    if (!awaitingClarification) return
    const chat = useChatStore.getState()
    chat.startRequirementProgress(awaitingClarification.conversationId, '正在读取你确认的澄清选项')
    try {
      await window.eva.requirements.answer({ conversationId: awaitingClarification.conversationId, runId: awaitingClarification.id, answers })
      await chat.refreshConversation(awaitingClarification.conversationId)
      await loadAwaitingClarification()
    } finally {
      chat.finishRequirementProgress(awaitingClarification.conversationId)
    }
  }, [awaitingClarification, loadAwaitingClarification])

  const abortClarificationAnalysis = useCallback(async () => {
    if (!awaitingClarification) return
    await window.eva.requirements.abort(awaitingClarification.conversationId)
  }, [awaitingClarification])

  const submitSpecificationResolution = useCallback(async (answers: RequirementClarificationAnswer[]) => {
    if (!awaitingSpecResolution) return
    const chat = useChatStore.getState()
    chat.startRequirementProgress(awaitingSpecResolution.conversationId, '正在保存规格阻塞的处置选择')
    try {
      await window.eva.requirements.resolveSpec({ conversationId: awaitingSpecResolution.conversationId, runId: awaitingSpecResolution.id, answers })
      await chat.refreshConversation(awaitingSpecResolution.conversationId)
      await loadAwaitingClarification()
    } finally {
      chat.finishRequirementProgress(awaitingSpecResolution.conversationId)
    }
  }, [awaitingSpecResolution, loadAwaitingClarification])

  const abortSpecificationResolution = useCallback(async () => {
    if (!awaitingSpecResolution) return
    await window.eva.requirements.abort(awaitingSpecResolution.conversationId)
  }, [awaitingSpecResolution])

  const updateScrollAffordances = useCallback((scrollArea: HTMLDivElement, reveal = false) => {
    const overflow = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight)
    const height = scrollArea.scrollHeight > 0
      ? Math.min(100, Math.max(9, (scrollArea.clientHeight / scrollArea.scrollHeight) * 100))
      : 100
    const top = overflow > 0 ? (scrollArea.scrollTop / overflow) * (100 - height) : 0
    setScrollIndicator((previous) => (
      Math.abs(previous.top - top) < 0.2 && Math.abs(previous.height - height) < 0.2
        ? previous
        : { top, height }
    ))
    setCanJumpToBottom(overflow - scrollArea.scrollTop > JUMP_TO_BOTTOM_THRESHOLD)

    if (!reveal) return
    setScrollIndicatorVisible(true)
    if (scrollIndicatorTimerRef.current !== null) window.clearTimeout(scrollIndicatorTimerRef.current)
    scrollIndicatorTimerRef.current = window.setTimeout(() => {
      setScrollIndicatorVisible(false)
      scrollIndicatorTimerRef.current = null
    }, 900)
  }, [])

  const scrollToBottom = (behavior: ScrollBehavior) => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return false
    scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior })
    const nextScrollTop = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight)
    lastScrollTopRef.current = nextScrollTop
    setScrollTop(nextScrollTop)
    updateScrollAffordances(scrollArea, behavior === 'smooth')
    return true
  }

  const saveScrollPosition = (conversationId = currentConversationId, persist = false) => {
    const scrollArea = scrollAreaRef.current
    if (!conversationId) return
    const offset = scrollArea?.scrollTop ?? lastScrollTopRef.current
    rememberScrollPosition(conversationId, offset, persist)
  }

  useLayoutEffect(() => {
    // Settings replaces the chat subtree. Layout-effect cleanup runs while
    // this scroll container still exists, unlike passive cleanup which can
    // run after React has detached the DOM node and lost the real offset.
    return () => {
      const conversationId = activeConversationIdRef.current
      const scrollArea = scrollAreaRef.current
      if (!conversationId || !scrollArea) return
      lastScrollTopRef.current = scrollArea.scrollTop
      rememberScrollPosition(conversationId, scrollArea.scrollTop, true)
    }
  }, [])

  const processScroll = () => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return

    // Selecting a conversation causes the browser to emit an initial scroll
    // event at the top of the reused surface. Do not let that event replace
    // this conversation's saved position before restoration has completed.
    const isRestoringCurrentConversation = pendingRestoreRef.current === currentConversationId
    if (isRestoringCurrentConversation) {
      setScrollTop(scrollArea.scrollTop)
      setViewportHeight(scrollArea.clientHeight)
      updateScrollAffordances(scrollArea)
      return
    }

    lastScrollTopRef.current = scrollArea.scrollTop
    if (scrollPersistTimerRef.current !== null) window.clearTimeout(scrollPersistTimerRef.current)
    scrollPersistTimerRef.current = window.setTimeout(() => {
      saveScrollPosition()
      persistScrollPositions()
      scrollPersistTimerRef.current = null
    }, 320)
    setScrollTop((previous) => (
      Math.abs(previous - scrollArea.scrollTop) >= VIRTUAL_SCROLL_UPDATE_THRESHOLD
        ? scrollArea.scrollTop
        : previous
    ))
    setViewportHeight(scrollArea.clientHeight)
    followStreamRef.current = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight <= SCROLL_FOLLOW_THRESHOLD
    const now = performance.now()
    if (now - lastScrollAffordanceUpdateAtRef.current >= SCROLL_AFFORDANCE_UPDATE_INTERVAL) {
      lastScrollAffordanceUpdateAtRef.current = now
      updateScrollAffordances(scrollArea, true)
    }
  }

  const handleScroll = () => {
    // Native wheel and touchpad scrolling can produce far more events than the
    // browser can paint. Applying state for each event re-renders Markdown
    // while it is moving, which made long answers appear to vibrate. Keep only
    // the latest position in each paint frame instead.
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      processScroll()
    })
  }

  // Keep older history out of the DOM until requested. The current page is
  // virtualized again below, so a large Markdown response does not make all
  // of its neighbors expensive to render.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
    setMeasuredHeights({})
    const savedOffset = currentConversationId ? conversationScrollOffsets.get(currentConversationId) ?? 0 : 0
    lastScrollTopRef.current = savedOffset
    setScrollTop(savedOffset)
  }, [currentConversationId])

  useEffect(() => () => {
    if (scrollIndicatorTimerRef.current !== null) window.clearTimeout(scrollIndicatorTimerRef.current)
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  // Tool-role messages are retained for a valid model tool-call history, but
  // their full output is already available from the preceding tool card.
  // Rendering them as chat bubbles duplicates large search/page results.
  const renderableMessages = useMemo(() => messages.filter((message) => message.role !== 'tool'), [messages])
  const conversationUsage = useMemo(() => sumConversationUsage(renderableMessages), [renderableMessages])
  const latestUsageMessageId = useMemo(
    () => [...renderableMessages].reverse().find((message) => message.role === 'assistant' && message.usage)?.id,
    [renderableMessages]
  )

  const visibleMessages = useMemo(() => {
    return renderableMessages.length <= visibleCount
      ? renderableMessages
      : renderableMessages.slice(renderableMessages.length - visibleCount)
  }, [renderableMessages, visibleCount])

  const hasMore = renderableMessages.length > visibleCount
  const renderItems = useMemo<RenderItem[]>(() => {
    return visibleMessages.map((message) => ({
      id: `message-${message.id}`,
      kind: 'message',
      message,
    }))
  }, [visibleMessages])

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

  useEffect(() => {
    const flushScrollPosition = () => {
      saveScrollPosition(activeConversationIdRef.current, true)
      if (scrollPersistTimerRef.current !== null) {
        window.clearTimeout(scrollPersistTimerRef.current)
        scrollPersistTimerRef.current = null
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushScrollPosition()
    }

    window.addEventListener('pagehide', flushScrollPosition)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      // The layout-effect cleanup above owns unmount persistence because it
      // runs before the scroll node is detached. This cleanup only releases
      // global listeners and pending timers.
      if (scrollPersistTimerRef.current !== null) {
        window.clearTimeout(scrollPersistTimerRef.current)
        scrollPersistTimerRef.current = null
      }
      window.removeEventListener('pagehide', flushScrollPosition)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useLayoutEffect(() => {
    activeConversationIdRef.current = currentConversationId
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

    // A stored scrollTop is meaningful only when the virtual list exposes the
    // complete conversation height. With just the newest page in the layout,
    // an older position is clamped and appears to be shared with the top.
    if (visibleCount < renderableMessages.length) {
      setVisibleCount(renderableMessages.length)
      return
    }

    const savedOffset = conversationScrollOffsets.get(conversationId)
    let settleTimer: number | null = null
    let finalSettleTimer: number | null = null
    let secondFrame: number | null = null
    const restore = () => {
      const area = scrollAreaRef.current
      if (!area || pendingRestoreRef.current !== conversationId) return

      area.scrollTop = savedOffset === undefined
        ? area.scrollHeight
        : Math.min(savedOffset, Math.max(0, area.scrollHeight - area.clientHeight))
      lastScrollTopRef.current = area.scrollTop
      setScrollTop(area.scrollTop)
      setViewportHeight(area.clientHeight)
      followStreamRef.current = area.scrollHeight - area.scrollTop - area.clientHeight <= SCROLL_FOLLOW_THRESHOLD
      updateScrollAffordances(area)
    }

    // The virtualized list needs one layout frame to establish its spacers.
    // Apply the saved position again after it settles so loading a long
    // conversation cannot clamp the reader back to the top.
    const firstFrame = requestAnimationFrame(() => {
      restore()
      secondFrame = requestAnimationFrame(() => {
        restore()
        settleTimer = window.setTimeout(() => {
          restore()
          // Measured message heights can update after the first layout pass.
          // Keep restoration exclusive to this conversation until that final
          // pass completes, then allow its future user scrolls to persist.
          finalSettleTimer = window.setTimeout(() => {
            restore()
            previousMessageCountRef.current = messages.length
            pendingRestoreRef.current = null
          }, 320)
        }, 240)
      })
    })

    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) cancelAnimationFrame(secondFrame)
      if (settleTimer !== null) window.clearTimeout(settleTimer)
      if (finalSettleTimer !== null) window.clearTimeout(finalSettleTimer)
    }
  }, [currentConversationId, isConversationLoading, messages.length, renderableMessages.length, updateScrollAffordances, visibleCount])

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
    // Tool state can update rapidly during desktop observation. Following on
    // those updates kept resetting scrollTop near the bottom and made the
    // rendered text visibly shake. Only follow newly streamed text.
    if (
      isStreaming &&
    (streamingContent || streamingReasoningContent) &&
      pendingRestoreRef.current !== currentConversationId &&
      followStreamRef.current
    ) {
      scrollToBottom('auto')
    }
  }, [isStreaming, streamingContent, streamingReasoningContent])

  if (messages.length === 0 && !isConversationLoading && !isStreaming && !isTeamRunning && !isRequirementRunning) {
    return <WelcomeScreen className={className} />
  }

  const jumpToBottomLabel = language === 'zh' ? '回到最新消息' : language === 'ja' ? '最新メッセージへ' : 'Jump to latest message'

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <ScrollArea
        key={currentConversationId ?? 'no-conversation'}
        ref={scrollAreaRef}
        onScroll={handleScroll}
        className="eva-message-scroll h-full"
      >
      <div
        className={cn(
          'flex w-full flex-col px-8 py-10',
          rightPanelVisible && 'mx-auto max-w-[72rem]'
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
            <MessageBubble
              message={item.message}
              conversationUsage={item.message.id === latestUsageMessageId ? conversationUsage : undefined}
            />
          </div>
        ))}

        {virtualRange.bottomSpacer > 0 && <div aria-hidden="true" style={{ height: virtualRange.bottomSpacer }} />}

        {requirementProgress && (
          <section className="mb-8 w-full max-w-none border-l-2 border-violet-500 bg-violet-50/50 px-4 py-3.5" role="status" aria-live="polite" aria-label="需求工程执行进度">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-900">
              <Loader2 className={cn('h-4 w-4 text-violet-600', SMOOTH_SPIN_CLASS)} />
              <RequirementElapsedTime startedAt={requirementProgress.startedAt} />
              <span>需求工程</span>
            </div>
            <ol className="mt-3 space-y-2">
              {requirementProgress.steps.map((step) => {
                const isCurrent = step.phase === 'started' || (!step.document && step.stage === requirementProgress.current.stage)
                return (
                  <li key={step.document?.id || `${step.stage}-${step.message}`} className="flex items-center gap-2 text-sm">
                    {isCurrent
                      ? <Loader2 className={cn('h-3.5 w-3.5 shrink-0 text-violet-600', SMOOTH_SPIN_CLASS)} />
                      : step.phase === 'failed'
                        ? <CircleAlert className="h-3.5 w-3.5 shrink-0 text-rose-600" />
                        : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
                    <span className={cn(isCurrent ? 'font-medium text-violet-800' : 'text-zinc-600')}>{step.message}</span>
                  </li>
                )
              })}
            </ol>
            {requirementProgress.steps.filter((step) => step.document).map((step) => (
              <details key={step.document!.id} open className="mt-3 border-t border-violet-100 pt-3">
                <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-violet-800">
                  {step.phase === 'started' ? <Loader2 className={cn('h-3.5 w-3.5 text-violet-600', SMOOTH_SPIN_CLASS)} /> : step.phase === 'failed' ? <CircleAlert className="h-3.5 w-3.5 text-rose-600" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
                  <span>{step.document!.title}</span>
                  {step.phase === 'started' && <span className="text-xs font-normal text-violet-600">正在生成</span>}
                  {step.phase === 'failed' && <span className="text-xs font-normal text-rose-600">生成失败</span>}
                </summary>
                <MarkdownMessageContent content={step.document!.content} className="mt-2 text-zinc-700" />
              </details>
            ))}
          </section>
        )}

        {awaitingClarification && !requirementProgress && (
          <RequirementClarificationCard
            run={awaitingClarification}
            onSubmit={submitClarificationAnswers}
            onAbort={abortClarificationAnalysis}
          />
        )}

        {awaitingSpecResolution && !requirementProgress && (
          <RequirementClarificationCard
            run={awaitingSpecResolution}
            mode="specification"
            onSubmit={submitSpecificationResolution}
            onAbort={abortSpecificationResolution}
          />
        )}

        {isTeamRunning && (
          <div className="flex items-center gap-2 px-0 py-1 text-sm text-zinc-500">
            <Loader2 className={cn('h-4 w-4 text-violet-500', SMOOTH_SPIN_CLASS)} />
            <span>Expert Team is planning and assigning work...</span>
          </div>
        )}

        {/* Render the in-flight Markdown through the same assistant-message surface.
            ReactMarkdown tolerates incomplete syntax and progressively settles as
            subsequent chunks arrive. */}
        {isStreaming && (streamingContent || streamingReasoningContent) && (
          <MessageBubble
            isStreaming
            message={{
              id: `streaming-${currentConversationId || 'message'}`,
              conversationId: currentConversationId || '',
              role: 'assistant',
              content: streamingContent,
              reasoningContent: streamingReasoningContent || undefined,
              timestamp: Date.now(),
            }}
          />
        )}
        </div>
      </ScrollArea>

      <div
        className="pointer-events-none absolute bottom-5 right-3 top-7 z-20"
        style={rightPanelVisible ? { right: `${12 - rightPanelWidth}px` } : undefined}
      >
        <div
          aria-hidden="true"
          className={cn(
            'absolute bottom-0 right-0 top-0 w-[3px] transition-opacity duration-300',
            scrollIndicatorVisible ? 'opacity-100' : 'opacity-0'
          )}
        >
          <span
            className="absolute left-0 w-full rounded-full bg-violet-300/70 shadow-[0_0_7px_rgba(139,92,246,0.2)] transition-[top,height] duration-150"
            style={{ top: `${scrollIndicator.top}%`, height: `${scrollIndicator.height}%` }}
          />
        </div>

        {canJumpToBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            title={jumpToBottomLabel}
            aria-label={jumpToBottomLabel}
            className="pointer-events-auto absolute bottom-2 right-3 grid h-9 w-9 place-items-center rounded-full border border-violet-100 bg-white/90 text-violet-500 shadow-[0_12px_24px_-15px_rgba(79,70,229,0.5)] backdrop-blur transition duration-200 hover:-translate-y-0.5 hover:border-violet-200 hover:bg-violet-50 hover:text-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-200"
          >
            <ChevronsDown className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  )
}
