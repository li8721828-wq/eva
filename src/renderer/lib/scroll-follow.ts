/** The reader's own scrolling direction, as observed from a raw input event. */
export type UserScrollIntent = 'none' | 'up' | 'down'

/**
 * The decision behind "is the reader following the latest message?".
 *
 * It is deliberately not a plain distance test. Within one frame the browser
 * applies the user's wheel delta, then runs our auto-scroll callbacks, then
 * dispatches the `scroll` event with the *final* position. A distance-only
 * rule therefore reads the bottom, re-arms following, and makes the upward
 * gesture invisible — the transcript stays glued to the newest text and the
 * reader cannot scroll back. So the caller supplies the user's own intent, and
 * this function keeps auto-follow alive when nothing but streamed content
 * moved.
 */
export interface FollowStateInput {
  distanceFromBottom: number
  wasFollowing: boolean
  /** The reported position differs from the one we last wrote ourselves. */
  movedByUser: boolean
  userIntent: UserScrollIntent
  /** Distance from the bottom that still counts as following. */
  followThreshold: number
  /** Tighter distance required to re-arm following after the reader took over. */
  reengageThreshold: number
}

/**
 * A `scroll` event that lands within this many pixels of the position we wrote
 * is an echo of our own programmatic scroll, not reader movement.
 */
const SCROLL_ECHO_TOLERANCE_PX = 1

export function intentFromWheelDelta(deltaY: number): UserScrollIntent {
  if (deltaY < 0) return 'up'
  if (deltaY > 0) return 'down'
  return 'none'
}

export function didUserMoveScrollTop(
  offset: number,
  lastWrittenTop: number,
  tolerance: number = SCROLL_ECHO_TOLERANCE_PX,
): boolean {
  // The sentinel for "this container has not been scrolled by us yet" must not
  // read as an echo: a transcript opened at the very top reports 0, which sits
  // within a pixel of the sentinel.
  if (lastWrittenTop < 0) return true
  return Math.abs(offset - lastWrittenTop) > tolerance
}

export function resolveFollowing(input: FollowStateInput): boolean {
  // An explicit upward gesture outranks every other signal, including a small
  // move that stays inside the follow band: trackpads and slow wheels routinely
  // travel less than the threshold, and a sub-threshold release would be
  // instantly re-pinned by the next layout pass.
  if (input.userIntent === 'up') return false

  // Bottom content growing keeps scrollTop where we left it. Releasing on that
  // would stop auto-follow for a reader who never touched the transcript.
  if (!input.movedByUser) return input.wasFollowing

  // Virtualized spacer changes clamp scrollTop without any reader input, so the
  // pinned case falls back to distance and survives a layout settle.
  if (input.wasFollowing || input.userIntent === 'down') {
    return input.distanceFromBottom <= input.followThreshold
  }

  // Hysteresis: once the reader has taken over, they must return to the bottom
  // edge before auto-follow resumes, otherwise stopping just above the last
  // line would snatch the view away again.
  return input.distanceFromBottom <= input.reengageThreshold
}
