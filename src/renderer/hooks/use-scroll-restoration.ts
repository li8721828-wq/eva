import { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react'
import {
  didUserMoveScrollTop,
  intentFromWheelDelta,
  resolveFollowing,
  type UserScrollIntent,
} from '../lib/scroll-follow'

/**
 * Encapsulates the conversation-scroll lifecycle that the chat transcript
 * previously kept inline: per-conversation offset memory, debounced
 * persistence, the "follow latest message" rule, and the manual jump-to-bottom
 * affordance.  Returning a small bundle keeps `MessageList` focused on the
 * visible rendering and makes the behavior unit-testable in isolation.
 *
 * Behavior summary:
 *  - `offset` is the latest scroll position the caller has reported.
 *  - `update(offset)` records the new position and triggers persistence.
 *  - `restore(conversationId)` jumps to the saved offset (or the bottom for a
 *    never-seen conversation) and re-asserts it across three layout frames so
 *    a virtualized list that just inserted spacers cannot clamp the reader
 *    back to the top.
 *  - `jumpToBottom(behavior)` smoothly or instantly returns to the bottom and
 *    re-engages auto-follow.
 *  - `attach(element)` also listens for the reader's own wheel and touch
 *    gestures on that element, because auto-follow must yield to intent rather
 *    than to a scroll position the host's auto-follow keeps rewriting.
 *  - `reportViewportHeight(height)` feeds viewport height into the host so it
 *    can size the virtual range.
 */
interface GestureBinding {
  element: HTMLElement
  onWheel: (event: WheelEvent) => void
  onTouchStart: (event: TouchEvent) => void
  onTouchMove: (event: TouchEvent) => void
}

export interface ScrollRestorationOptions {
  /** localStorage key for the saved offsets map. */
  storageKey: string
  /** Maximum number of conversations whose offset we keep on disk. */
  maxSaved?: number
  /** Distance (in px) from the bottom that still counts as "following". */
  followThreshold?: number
  /** Tighter distance needed to re-arm following once the reader took over. */
  reengageThreshold?: number
  /** Distance from the bottom past which the jump-to-bottom affordance appears. */
  jumpToBottomThreshold?: number
  /** Coalesce persistence events to this interval. */
  persistDebounceMs?: number
  /** ms after which a "settled" restore frame stops being authoritative. */
  finalSettleMs?: number
}

export interface ScrollRestorationController {
  /** Bind the current scroll container, including after keyed remounts. */
  attach: (element: HTMLElement | null) => void
  /** Set the scroll position the host last observed. */
  recordOffset: (offset: number) => void
  /** Report a live scroll position and update the auto-follow state. */
  reportScrollPosition: (offset: number, scrollHeight: number, clientHeight: number) => void
  /** Persist any pending offset immediately (called on page hide / unmount). */
  flush: () => void
  /** Restore the saved offset for a conversation; pass `null` for a brand-new chat. */
  restore: (conversationId: string | null) => () => void
  /** Smoothly or instantly snap to the bottom and re-engage auto-follow. */
  jumpToBottom: (behavior: ScrollBehavior) => boolean
  /** Whether the reader is currently within `followThreshold` of the bottom. */
  isFollowing: () => boolean
  /**
   * Report a scroll gesture coming straight from the reader. An upward gesture
   * releases auto-follow immediately; the position-derived rule cannot do it,
   * because the host's own auto-scroll rewrites the reported position first.
   */
  notifyUserIntent: (intent: UserScrollIntent) => void
  /** Current viewport height (set by `reportViewportHeight`). */
  viewportHeight: number
  reportViewportHeight: (height: number) => void
  /** Whether the user is far enough above the bottom to deserve the jump button. */
  canJumpToBottom: boolean
  setCanJumpToBottom: (value: boolean) => void
}

const DEFAULTS = {
  maxSaved: 200,
  followThreshold: 72,
  reengageThreshold: 24,
  jumpToBottomThreshold: 240,
  persistDebounceMs: 320,
  finalSettleMs: 320,
}

export function useScrollRestoration(options: ScrollRestorationOptions): ScrollRestorationController {
  const storageKey = options.storageKey
  const maxSaved = options.maxSaved ?? DEFAULTS.maxSaved
  const followThreshold = options.followThreshold ?? DEFAULTS.followThreshold
  const reengageThreshold = options.reengageThreshold ?? DEFAULTS.reengageThreshold
  const jumpToBottomThreshold = options.jumpToBottomThreshold ?? DEFAULTS.jumpToBottomThreshold
  const persistDebounceMs = options.persistDebounceMs ?? DEFAULTS.persistDebounceMs
  const finalSettleMs = options.finalSettleMs ?? DEFAULTS.finalSettleMs

  const offsetsRef = useRef<Map<string, number>>(new Map())
  const scrollElementRef = useRef<HTMLElement | null>(null)
  const gestureBindingRef = useRef<GestureBinding | null>(null)
  const touchAnchorYRef = useRef<number | null>(null)
  const currentConversationIdRef = useRef<string | null>(null)
  const lastOffsetRef = useRef(0)
  const lastWrittenTopRef = useRef(-1)
  const pendingConversationIdRef = useRef<string | null>(null)
  const followRef = useRef(true)
  const intentRef = useRef<UserScrollIntent>('none')
  const readerTookOverRef = useRef(false)
  const persistTimerRef = useRef<number | null>(null)
  const [viewportHeight, setViewportHeight] = useState(800)
  const [canJumpToBottom, setCanJumpToBottom] = useState(false)

  // Hydrate the offset cache exactly once per mount; missing storage or
  // malformed JSON must never block rendering of the chat transcript.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [conversationId, offset] of Object.entries(parsed)) {
        if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) {
          offsetsRef.current.set(conversationId, offset)
        }
      }
    } catch {
      // ignore; restore can still operate from the in-memory map.
    }
  }, [storageKey])

  const persistOffsets = useCallback(() => {
    if (typeof window === 'undefined') return
    try {
      const entries = Array.from(offsetsRef.current.entries()).slice(-maxSaved)
      window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)))
    } catch {
      // localStorage may be unavailable in restrictive profiles.
    }
  }, [maxSaved, storageKey])

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null
      persistOffsets()
    }, persistDebounceMs)
  }, [persistDebounceMs, persistOffsets])

  const recordOffset = useCallback((offset: number) => {
    const safe = Math.max(0, offset)
    lastOffsetRef.current = safe
    const id = currentConversationIdRef.current
    if (id) {
      offsetsRef.current.set(id, safe)
      schedulePersist()
    }
  }, [schedulePersist])

  const reportScrollPosition = useCallback((offset: number, scrollHeight: number, clientHeight: number) => {
    recordOffset(offset)
    const distanceFromBottom = Math.max(0, scrollHeight - offset - clientHeight)
    const userIntent = intentRef.current
    intentRef.current = 'none'
    followRef.current = resolveFollowing({
      distanceFromBottom,
      wasFollowing: followRef.current,
      movedByUser: didUserMoveScrollTop(offset, lastWrittenTopRef.current),
      userIntent,
      followThreshold,
      reengageThreshold,
    })
    if (followRef.current) readerTookOverRef.current = false
    setCanJumpToBottom(distanceFromBottom > jumpToBottomThreshold)
  }, [followThreshold, jumpToBottomThreshold, recordOffset, reengageThreshold])

  const notifyUserIntent = useCallback((intent: UserScrollIntent) => {
    if (intent === 'none') return
    intentRef.current = intent
    if (intent !== 'up') return
    // Release immediately instead of waiting for the next `scroll` event: that
    // event is dispatched after our own auto-scroll has already rewritten the
    // position, so a position-only rule would never see the gesture at all.
    followRef.current = false
    // Restore re-asserts the saved offset for a few frames after a conversation
    // switch; a reader who just took over must not be dragged back by them.
    readerTookOverRef.current = true
  }, [])

  const flush = useCallback(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    persistOffsets()
  }, [persistOffsets])

  const isFollowing = useCallback(() => followRef.current, [])

  const reportViewportHeight = useCallback((height: number) => {
    setViewportHeight((previous) => Math.abs(previous - height) < 1 ? previous : height)
  }, [])

  // A programmatic jump owns the scroll position: record the exact value we
  // wrote so the `scroll` event it produces is not mistaken for reader movement.
  const jumpToBottom = useCallback((behavior: ScrollBehavior): boolean => {
    const element = scrollElementRef.current
    if (!element) return false
    followRef.current = true
    intentRef.current = 'none'
    readerTookOverRef.current = false
    pendingConversationIdRef.current = null
    element.scrollTo({ top: element.scrollHeight, behavior })
    const next = Math.max(0, element.scrollHeight - element.clientHeight)
    if (behavior === 'auto') element.scrollTop = next
    lastWrittenTopRef.current = next
    lastOffsetRef.current = next
    recordOffset(next)
    setCanJumpToBottom(false)
    return true
  }, [recordOffset])

  const detachGestureListeners = useCallback(() => {
    const binding = gestureBindingRef.current
    if (!binding) return
    binding.element.removeEventListener('wheel', binding.onWheel)
    binding.element.removeEventListener('touchstart', binding.onTouchStart)
    binding.element.removeEventListener('touchmove', binding.onTouchMove)
    gestureBindingRef.current = null
  }, [])

  /**
   * Wire a scroll container to the controller.  The host should call this on
   * every render so a freshly-mounted element can be observed immediately.
   * The reader's own gesture listeners ride along with the container, because
   * auto-follow cannot be derived from the container's `scroll` event alone:
   * that event is dispatched after our auto-scroll has rewritten the position.
   */
  const attach = useCallback((element: HTMLElement | null) => {
    scrollElementRef.current = element
    const binding = gestureBindingRef.current
    if (binding && binding.element === element) return
    detachGestureListeners()
    lastWrittenTopRef.current = -1
    intentRef.current = 'none'
    touchAnchorYRef.current = null
    if (!element) return

    // A wheel the transcript's own content cannot consume — because it landed
    // inside a nested scroll area such as the streaming bubble's tool activity
    // list, which contains its scroll chain — never moves the transcript.
    // Treating it as a takeover would silently stop auto-follow while the
    // reader is browsing process output, exactly the thing they are watching.
    const isNestedScroll = (target: EventTarget | null) => {
      let node = target instanceof Element ? target : null
      while (node && node !== element) {
        if (node.scrollHeight - node.clientHeight > 1) return true
        node = node.parentElement
      }
      return false
    }

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 || isNestedScroll(event.target)) return
      notifyUserIntent(intentFromWheelDelta(event.deltaY))
    }

    const onTouchStart = (event: TouchEvent) => {
      touchAnchorYRef.current = event.touches[0]?.clientY ?? null
    }

    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY
      const anchor = touchAnchorYRef.current
      if (y === undefined || anchor === null) return
      const delta = y - anchor
      touchAnchorYRef.current = y
      if (Math.abs(delta) < 4 || isNestedScroll(event.target)) return
      // Dragging the finger down walks the reader back up the transcript.
      notifyUserIntent(delta > 0 ? 'up' : 'down')
    }

    element.addEventListener('wheel', onWheel, { passive: true })
    element.addEventListener('touchstart', onTouchStart, { passive: true })
    element.addEventListener('touchmove', onTouchMove, { passive: true })
    gestureBindingRef.current = { element, onWheel, onTouchStart, onTouchMove }
  }, [detachGestureListeners, notifyUserIntent])

  useEffect(() => () => detachGestureListeners(), [detachGestureListeners])

  /**
   * Restore the saved offset for `conversationId`.  Returns a teardown that
   * cancels any pending restore frames — the host calls it before starting a
   * new restore.
   */
  const restore = useCallback((conversationId: string | null) => {
    const element = scrollElementRef.current
    currentConversationIdRef.current = conversationId
    pendingConversationIdRef.current = conversationId
    readerTookOverRef.current = false
    if (!element || !conversationId) {
      lastOffsetRef.current = 0
      lastWrittenTopRef.current = -1
      intentRef.current = 'none'
      followRef.current = true
      return () => undefined
    }

    const savedOffset = offsetsRef.current.get(conversationId)
    let secondFrame: number | null = null
    let settleTimer: number | null = null
    let finalSettleTimer: number | null = null

    const apply = () => {
      const current = scrollElementRef.current
      if (!current || pendingConversationIdRef.current !== conversationId) return
      if (readerTookOverRef.current) return
      const overflow = Math.max(0, current.scrollHeight - current.clientHeight)
      const target = savedOffset === undefined ? overflow : Math.min(savedOffset, overflow)
      current.scrollTop = target
      lastWrittenTopRef.current = target
      lastOffsetRef.current = target
      setViewportHeight(current.clientHeight)
      // Restoration determines the initial follow state from the restored
      // position. Later user scrolling updates it through reportScrollPosition.
      followRef.current = overflow - target <= followThreshold
      setCanJumpToBottom(overflow - target > jumpToBottomThreshold)
    }

    const firstFrame = requestAnimationFrame(() => {
      apply()
      secondFrame = requestAnimationFrame(() => {
        apply()
        settleTimer = window.setTimeout(() => {
          apply()
          finalSettleTimer = window.setTimeout(() => {
            apply()
            pendingConversationIdRef.current = null
          }, finalSettleMs)
        }, finalSettleMs)
      })
    })

    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) cancelAnimationFrame(secondFrame)
      if (settleTimer !== null) window.clearTimeout(settleTimer)
      if (finalSettleTimer !== null) window.clearTimeout(finalSettleTimer)
    }
  }, [finalSettleMs, followThreshold, jumpToBottomThreshold])

  // Listen for `pagehide` and `visibilitychange` so a tab close or hide does
  // not lose the last few hundred ms of scroll position work.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [flush])

  return {
    attach,
    recordOffset,
    reportScrollPosition,
    flush,
    restore,
    jumpToBottom,
    isFollowing,
    notifyUserIntent,
    viewportHeight,
    reportViewportHeight,
    canJumpToBottom,
    setCanJumpToBottom,
  }
}
