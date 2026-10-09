import { describe, expect, it } from 'vitest'
import {
  didUserMoveScrollTop,
  intentFromWheelDelta,
  resolveFollowing,
  type FollowStateInput,
} from '../../src/renderer/lib/scroll-follow'

const THRESHOLDS = { followThreshold: 72, reengageThreshold: 24 }

function decide(input: Partial<FollowStateInput>): boolean {
  return resolveFollowing({
    distanceFromBottom: 0,
    wasFollowing: true,
    movedByUser: false,
    userIntent: 'none',
    ...THRESHOLDS,
    ...input,
  })
}

// Regression: streamed text revealed on a 42ms tick re-pins the transcript about
// 24 times a second, and the `scroll` event reports the position *after* that
// pin. A distance-only rule therefore never saw the reader's upward gesture.
describe('resolveFollowing', () => {
  it('keeps following when only the streamed content grew', () => {
    expect(decide({ movedByUser: false, distanceFromBottom: 320 })).toBe(true)
  })

  it('releases on an upward gesture that stays inside the follow band', () => {
    expect(decide({ userIntent: 'up', movedByUser: true, distanceFromBottom: 20 })).toBe(false)
  })

  it('releases on an upward gesture even while the reported position is the bottom', () => {
    expect(decide({ userIntent: 'up', distanceFromBottom: 0 })).toBe(false)
  })

  it('releases once the reader has moved past the follow band', () => {
    expect(decide({ movedByUser: true, distanceFromBottom: 200 })).toBe(false)
  })

  it('survives a virtualized spacer clamp that keeps the reader at the bottom', () => {
    expect(decide({ movedByUser: true, distanceFromBottom: 8 })).toBe(true)
  })

  it('does not re-arm for a reader who took over and stopped just above the bottom', () => {
    expect(
      decide({ wasFollowing: false, movedByUser: true, distanceFromBottom: 40 }),
    ).toBe(false)
  })

  it('re-arms once the reader returns to the bottom edge', () => {
    expect(
      decide({ wasFollowing: false, movedByUser: true, distanceFromBottom: 10 }),
    ).toBe(true)
  })

  it('re-arms a downward scroll that lands inside the follow band', () => {
    expect(
      decide({ wasFollowing: false, userIntent: 'down', movedByUser: true, distanceFromBottom: 60 }),
    ).toBe(true)
  })
})

describe('didUserMoveScrollTop', () => {
  it('treats the position we wrote ourselves as an echo', () => {
    expect(didUserMoveScrollTop(1200, 1200)).toBe(false)
    expect(didUserMoveScrollTop(1201, 1200)).toBe(false)
  })

  it('treats any real move as reader input', () => {
    expect(didUserMoveScrollTop(1150, 1200)).toBe(true)
  })

  it('treats the first report after binding a container as reader input', () => {
    expect(didUserMoveScrollTop(0, -1)).toBe(true)
  })
})

describe('intentFromWheelDelta', () => {
  it('maps the wheel direction to the reader intent', () => {
    expect(intentFromWheelDelta(-120)).toBe('up')
    expect(intentFromWheelDelta(120)).toBe('down')
    expect(intentFromWheelDelta(0)).toBe('none')
  })
})
