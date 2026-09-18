import React, { useRef, useEffect, useLayoutEffect, useState, useMemo, useCallback } from 'react'
import type { ChatMessage, ChatUsage } from '../../../shared/types'
import { useChatStore } from '@/stores/use-chat-store'
import { ScrollArea } from '@/components/ui/ScrollArea'
import { MarkdownMessageContent, MessageBubble } from './MessageBubble'
import { GoalConfirmationCard } from './GoalConfirmationCard'
import { ToolApprovalCard } from './ToolApprovalCard'
import { RequirementClarificationCard } from './RequirementClarificationCard'
import { CheckCircle2, ChevronsDown, CircleAlert, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/use-app-store'
import { useTaskStore } from '@/stores/use-task-store'
import type { RequirementClarificationAnswer, RequirementRun } from '../../../shared/types/requirement-engineering'
import { collapseToolHistoryMessages } from '@/lib/collapse-tool-history'
import { useScrollRestoration } from '@/hooks/use-scroll-restoration'

const PAGE_SIZE = 100
const CONVERSATION_SCROLL_STORAGE_KEY = 'eva.conversation-scroll-positions.v2'
const SMOOTH_SPIN_CLASS = 'animate-spin'
const ESTIMATED_MESSAGE_HEIGHT = 180
const VIRTUAL_OVERSCAN = 900
const VIRTUAL_SCROLL_UPDATE_THRESHOLD = 80
const SCROLL_AFFORDANCE_UPDATE_INTERVAL = 80

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
  // Atomic selectors (A1) keep the transcript from re-rendering when an
  // unrelated store field (e.g. `inputText`, `quotedMessage`) changes.
  const messages = useChatStore((s) => s.messages)
  const currentConversationId = useChatStore((s) => s.currentConversationId)
  const isConversationLoading = useChatStore((s) => s.isConversationLoading)
  const streamingByConversation = useChatStore((s) => s.streamingByConversation)
  const requirementProgressByConversation = useChatStore((s) => s.requirementProgressByConversation)
  const decideGoalConfirmation = useChatStore((s) => s.decideGoalConfirmation)
  const decideToolApproval = useChatStore((s) => s.decideToolApproval)
  const refreshConversation = useChatStore((s) => s.refreshConversation)
  const startRequirementProgress = useChatStore((s) => s.startRequirementProgress)
  const finishRequirementProgress = useChatStore((s) => s.finishRequirementProgress)

  const stream = currentConversationId ? streamingByConversation[currentConversationId] : undefined
  const isStreaming = Boolean(stream?.isStreaming)
  const streamingContent = stream?.content || ''
  const latestMessage = messages[messages.length - 1]
  const isDuplicateStreamingReply = Boolean(
    isStreaming &&
    streamingContent &&
    latestMessage?.role === 'assistant' &&
    latestMessage.content === streamingContent
  )
  const streamingReasoningContent = stream?.reasoningContent || ''
  const streamingAgentId = stream?.agentId
  const streamingAgentName = stream?.agentName
  const streamingToolCalls = stream?.toolCalls || []
  const streamingExecutionTrace = stream?.executionTrace || []
  const streamingExecutionTimeline = stream?.executionTimeline || []
  const streamingProgressUpdates = stream?.progressUpdates || []
  const goalConfirmation = stream?.goalConfirmation
  const toolApproval = stream?.toolApproval
  const requirementProgress = currentConversationId ? requirementProgressByConversation[currentConversationId] : undefined
  const isRequirementRunning = Boolean(requirementProgress)
  const rightPanelVisible = useAppStore((s) => s.rightPanelVisible)
  const language = useAppStore((s) => s.language)
  const isTeamRunning = useTaskStore((state) => Boolean(currentConversationId && state.expertTasks[currentConversationId]?.isRunning))
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const previousMessageCountRef = useRef(messages.length)
  const lastScrollAffordanceUpdateAtRef = useRef(0)
  const scrollFrameRef = useRef<number | null>(null)
  const forcedScrollFrameRef = useRef<number | null>(null)
  const initialScrollOffset = useScrollOffsetsFor(currentConversationId ?? '')
  const lastScrollTopRef = useRef(initialScrollOffset)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [scrollTop, setScrollTop] = useState(0)
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({})
  const itemElementsRef = useRef(new Map<string, HTMLDivElement>())
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const streamingElementRef = useRef<HTMLDivElement | null>(null)
  const scrollIndicatorTimerRef = useRef<number | null>(null)
  const [scrollIndicatorVisible, setScrollIndicatorVisible] = useState(false)
  const [scrollIndicator, setScrollIndicator] = useState<ScrollIndicator>({ top: 0, height: 100 })

  const scrollController = useScrollRestoration({
    storageKey: CONVERSATION_SCROLL_STORAGE_KEY,
  })

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
    startRequirementProgress(awaitingClarification.conversationId, '正在读取你确认的澄清选项')
    try {
      await window.eva.requirements.answer({ conversationId: awaitingClarification.conversationId, runId: awaitingClarification.id, answers })
      await refreshConversation(awaitingClarification.conversationId)
      await loadAwaitingClarification()
    } finally {
      finishRequirementProgress(awaitingClarification.conversationId)
    }
  }, [awaitingClarification, loadAwaitingClarification, refreshConversation, startRequirementProgress, finishRequirementProgress])

  const abortClarificationAnalysis = useCallback(async () => {
    if (!awaitingClarification) return
    await window.eva.requirements.abort(awaitingClarification.conversationId)
  }, [awaitingClarification])

  const submitSpecificationResolution = useCallback(async (answers: RequirementClarificationAnswer[]) => {
    if (!awaitingSpecResolution) return
    startRequirementProgress(awaitingSpecResolution.conversationId, '正在保存规格阻塞的处置选择')
    try {
      await window.eva.requirements.resolveSpec({ conversationId: awaitingSpecResolution.conversationId, runId: awaitingSpecResolution.id, answers })
      await refreshConversation(awaitingSpecResolution.conversationId)
      await loadAwaitingClarification()
    } finally {
      finishRequirementProgress(awaitingSpecResolution.conversationId)
    }
  }, [awaitingSpecResolution, loadAwaitingClarification, refreshConversation, startRequirementProgress, finishRequirementProgress])

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
    scrollController.setCanJumpToBottom(overflow - scrollArea.scrollTop > 240)

    if (!reveal) return
    setScrollIndicatorVisible(true)
    if (scrollIndicatorTimerRef.current !== null) window.clearTimeout(scrollIndicatorTimerRef.current)
    scrollIndicatorTimerRef.current = window.setTimeout(() => {
      setScrollIndicatorVisible(false)
      scrollIndicatorTimerRef.current = null
    }, 900)
  }, [scrollController])

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    return scrollController.jumpToBottom(behavior)
  }, [scrollController])

  const resumeFollowingLatestMessage = useCallback(() => {
    scrollController.jumpToBottom('auto')
    if (forcedScrollFrameRef.current !== null) cancelAnimationFrame(forcedScrollFrameRef.current)
    forcedScrollFrameRef.current = requestAnimationFrame(() => {
      scrollController.jumpToBottom('auto')
      forcedScrollFrameRef.current = requestAnimationFrame(() => {
        scrollController.jumpToBottom('auto')
        forcedScrollFrameRef.current = null
      })
    })
  }, [scrollController])

  // Persist any pending offset on layout cleanup. Layout-effect cleanup
  // runs while the scroll container still exists; passive cleanup would run
  // after React has detached the DOM node and lost the real offset.
  useLayoutEffect(() => {
    return () => {
      const scrollArea = scrollAreaRef.current
      if (scrollArea) {
        scrollController.recordOffset(scrollArea.scrollTop)
        scrollController.flush()
      }
    }
  }, [scrollController])

  const processScroll = useCallback(() => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return

    // Selecting a conversation causes the browser to emit an initial scroll
    // event at the top of the reused surface. Do not let that event replace
    // this conversation's saved position before restoration has completed.
    if (scrollController.isFollowing() === false && scrollArea.scrollTop < 32) {
      const wasPendingRestore = document.documentElement.dataset['restoreInFlight'] === '1'
      if (wasPendingRestore) return
    }

    scrollController.reportScrollPosition(
      scrollArea.scrollTop,
      scrollArea.scrollHeight,
      scrollArea.clientHeight,
    )
    setScrollTop((previous) => (
      Math.abs(previous - scrollArea.scrollTop) >= VIRTUAL_SCROLL_UPDATE_THRESHOLD
        ? scrollArea.scrollTop
        : previous
    ))
    scrollController.reportViewportHeight(scrollArea.clientHeight)
    const now = performance.now()
    if (now - lastScrollAffordanceUpdateAtRef.current >= SCROLL_AFFORDANCE_UPDATE_INTERVAL) {
      lastScrollAffordanceUpdateAtRef.current = now
      updateScrollAffordances(scrollArea, true)
    }
  }, [scrollController, updateScrollAffordances])

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
  }, [currentConversationId])

  useEffect(() => () => {
    if (scrollIndicatorTimerRef.current !== null) window.clearTimeout(scrollIndicatorTimerRef.current)
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
    if (forcedScrollFrameRef.current !== null) cancelAnimationFrame(forcedScrollFrameRef.current)
  }, [])

  // Goal child conversations retain each protocol event for safe resumption.
  // Collapse them here into one expandable activity item, so one tool never
  // becomes one empty assistant reply in the visible transcript.
  const liveProgressMessageIds = useMemo(() => {
    if (!isStreaming) return new Set<string>()
    const ids = new Set<string>()
    for (let index = messages.length - 1; index >= 0 && messages[index].progressKind; index--) {
      ids.add(messages[index].id)
    }
    return ids
  }, [isStreaming, messages])
  const renderableMessages = useMemo(
    () => collapseToolHistoryMessages(messages.filter((message) => !liveProgressMessageIds.has(message.id))),
    [liveProgressMessageIds, messages],
  )
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
    const endBoundary = scrollTop + scrollController.viewportHeight + VIRTUAL_OVERSCAN
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
  }, [itemLayout, measuredHeights, renderItems, scrollController.viewportHeight, scrollTop])

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setMeasuredHeights((previous) => {
        let changed = false
        const next = { ...previous }
        for (const entry of entries) {
          const target = entry.target as HTMLElement
          if (target.dataset.streamingItem === 'true') {
            // The streaming bubble is rendered outside the virtual list; we
            // never put it in the measurement map. Just keep auto-follow
            // glued to its bottom edge.
            if (scrollController.isFollowing() && previousMessageCountRef.current !== 0) {
              requestAnimationFrame(() => scrollController.jumpToBottom('auto'))
            }
            continue
          }
          const id = target.dataset.messageItemId
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
  }, [scrollController])

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

  const attachStreamingRef = useCallback((element: HTMLDivElement | null) => {
    const previousElement = streamingElementRef.current
    if (previousElement && previousElement !== element) resizeObserverRef.current?.unobserve(previousElement)
    streamingElementRef.current = element
    if (element) resizeObserverRef.current?.observe(element)
  }, [])

  // Bind the scroll element to the controller. We do this in an effect (not
  // during render) so React's commit phase can replace the underlying DOM
  // node on conversation switches without us holding onto a stale reference.
  const bindScrollArea = useCallback((element: HTMLDivElement | null) => {
    scrollAreaRef.current = element
    scrollController.attach(element)
  }, [scrollController.attach])

  // Restore scroll when the active conversation changes. We deliberately do
  // not couple this to the virtual list's `visibleCount` so a long history
  // being paged-in does not snap the reader back to the top.
  useLayoutEffect(() => {
    if (isConversationLoading) return
    // Re-engage auto-follow so sending a new message always jumps to the latest
    // reply even if the previous session was left scrolled up.
    const teardown = scrollController.restore(currentConversationId, true)
    previousMessageCountRef.current = messages.length
    return teardown
  }, [currentConversationId, isConversationLoading, scrollController.restore])

  // Auto-follow the latest message only when a real content change happened.
  // ResizeObserver-driven `measuredHeights` updates must not yank the reader
  // back to the bottom — those changes are layout stabilizations, not new
  // material.
  useLayoutEffect(() => {
    const previousMessageCount = previousMessageCountRef.current
    previousMessageCountRef.current = messages.length
    const latest = messages[messages.length - 1]

    if (
      messages.length > previousMessageCount
      && latest?.role === 'user'
      && latest.conversationId === currentConversationId
    ) {
      resumeFollowingLatestMessage()
      return
    }

    if (
      messages.length <= previousMessageCount ||
      !scrollController.isFollowing()
    ) return

    scrollController.jumpToBottom('auto')
  }, [currentConversationId, messages, resumeFollowingLatestMessage, scrollController])

  useLayoutEffect(() => {
    // A message can grow after its first render when Markdown settles or the
    // ResizeObserver records its actual height. Keep a pinned reader at the
    // physical bottom after that later layout pass, not just after the first
    // message insertion.
    if (
      scrollController.isFollowing()
    ) {
      scrollController.jumpToBottom('auto')
    }
  }, [currentConversationId, itemLayout.totalHeight, scrollController])

  useLayoutEffect(() => {
    // Keep the reader pinned after any streamed surface changes, including
    // tool rows and reasoning blocks that grow outside the virtual list.
    if (
      isStreaming &&
      (streamingContent || streamingReasoningContent || streamingToolCalls.length > 0 || streamingExecutionTrace.length > 0 || streamingExecutionTimeline.length > 0 || streamingProgressUpdates.length > 0) &&
      scrollController.isFollowing()
    ) {
      const frame = requestAnimationFrame(() => scrollController.jumpToBottom('auto'))
      return () => cancelAnimationFrame(frame)
    }
  }, [currentConversationId, isStreaming, scrollController, streamingContent, streamingReasoningContent, streamingExecutionTrace.length, streamingExecutionTimeline.length, streamingProgressUpdates.length, streamingToolCalls.length])

  if (messages.length === 0 && !isConversationLoading && !isStreaming && !isTeamRunning && !isRequirementRunning) {
    return <div className={cn('relative min-h-0 flex-1', className)} aria-hidden />
  }

  const jumpToBottomLabel = language === 'zh' ? '回到最新消息' : language === 'ja' ? '最新メッセージへ' : 'Jump to latest message'

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <ScrollArea
        key={currentConversationId ?? 'no-conversation'}
        ref={bindScrollArea}
        onScroll={handleScroll}
        className="eva-message-scroll h-full"
      >
      <div
        className={cn(
          'flex w-full flex-col px-8 pb-5 pt-10',
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
            className={cn('pb-9', item.id === renderItems[renderItems.length - 1]?.id && 'pb-4')}
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
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
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
                    <span className={cn(isCurrent ? 'font-medium text-violet-600' : 'text-zinc-600')}>{step.message}</span>
                  </li>
                )
              })}
            </ol>
            {requirementProgress.steps.filter((step) => step.document).map((step) => (
              <details key={step.document!.id} open className="mt-3 border-t border-violet-100 pt-3">
                <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-violet-600">
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

        {goalConfirmation && currentConversationId && (
          <GoalConfirmationCard
            request={goalConfirmation}
            onDecide={(approved) => void decideGoalConfirmation(currentConversationId, goalConfirmation.id, approved)}
          />
        )}

        {toolApproval && currentConversationId && (
          <ToolApprovalCard
            request={toolApproval}
            onDecide={(approved, rememberScope) => void decideToolApproval(currentConversationId, toolApproval.id, approved, rememberScope)}
          />
        )}

        {/* Render the in-flight Markdown through the same assistant-message surface.
            ReactMarkdown tolerates incomplete syntax and progressively settles as
            subsequent chunks arrive. */}
        {isStreaming && !isDuplicateStreamingReply && (
          <div ref={attachStreamingRef} data-streaming-item="true" className="pb-9">
            <MessageBubble
              isStreaming
              executingTools={streamingToolCalls.length > 0}
              message={{
                id: `streaming-${currentConversationId || 'message'}`,
                conversationId: currentConversationId || '',
                role: 'assistant',
                content: streamingContent,
                agentId: streamingAgentId,
                agentName: streamingAgentName,
                reasoningContent: streamingReasoningContent || undefined,
                toolCalls: streamingToolCalls.length > 0 ? streamingToolCalls : undefined,
                executionTrace: streamingExecutionTrace.length > 0 ? streamingExecutionTrace : undefined,
                executionTimeline: streamingExecutionTimeline.length > 0 ? streamingExecutionTimeline : undefined,
                progressUpdates: streamingProgressUpdates.length > 0 ? streamingProgressUpdates : undefined,
                timestamp: Date.now(),
              }}
            />
          </div>
        )}
        </div>
      </ScrollArea>

      <div
        className="pointer-events-none absolute bottom-5 right-1 top-7 z-20"
      >
        <div
          aria-hidden="true"
          className={cn(
            'absolute bottom-0 right-0 top-0 w-[2px] transition-opacity duration-300',
            scrollIndicatorVisible && scrollIndicator.height < 100 ? 'opacity-75' : 'opacity-0'
          )}
        >
          <span
            className="absolute left-0 w-full rounded-full bg-violet-400/60 shadow-[0_0_4px_rgba(139,92,246,0.14)] transition-[top,height] duration-150"
            style={{ top: `${scrollIndicator.top}%`, height: `${scrollIndicator.height}%` }}
          />
        </div>

        {scrollIndicatorVisible && scrollController.canJumpToBottom && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              scrollController.jumpToBottom('auto')
            }}
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

/**
 * Read-only accessor for the saved offset cache. Used as a stable seed for
 * `lastScrollTopRef` so the very first paint of a conversation starts at the
 * previously persisted position rather than 0.
 */
function useScrollOffsetsFor(conversationId: string): number {
  return useMemo(() => {
    if (typeof window === 'undefined') return 0
    try {
      const raw = window.localStorage.getItem(CONVERSATION_SCROLL_STORAGE_KEY)
      if (!raw) return 0
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const value = parsed[conversationId]
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    } catch {
      return 0
    }
  }, [conversationId])
}
