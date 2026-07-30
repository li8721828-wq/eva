import { describe, expect, it, vi } from 'vitest'
import { TaskExecutionQueue } from '../../src/main/services/task-execution-queue'

describe('TaskExecutionQueue', () => {
  it('limits concurrent task executions', async () => {
    let releaseFirst: (() => void) | undefined
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    const started: string[] = []
    const queue = new TaskExecutionQueue(1)

    queue.enqueue({ conversationId: 'one', kind: 'goal', run: async () => { started.push('one'); await first; return { status: 'completed' } } })
    queue.enqueue({ conversationId: 'two', kind: 'expert', run: async () => { started.push('two'); return { status: 'completed' } } })

    await vi.waitFor(() => expect(started).toEqual(['one']))
    releaseFirst?.()
    await vi.waitFor(() => expect(started).toEqual(['one', 'two']))
  })

  it('retries a failed task once before marking it failed', async () => {
    const updates: string[] = []
    const queue = new TaskExecutionQueue(1, () => 0)
    let attempts = 0

    queue.enqueue({
      conversationId: 'retry',
      kind: 'goal',
      run: async () => ({ status: attempts++ === 0 ? 'failed' : 'completed', error: 'temporary failure' }),
      onUpdate: (update) => { updates.push(`${update.state}:${update.attempt}`) },
    })

    await vi.waitFor(() => expect(updates).toContain('completed:2'))
    expect(updates).toContain('retrying:1')
  })

  it('does not run Goal and Team work concurrently in one conversation', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { release = resolve })
    const queue = new TaskExecutionQueue(2)

    expect(queue.enqueue({
      conversationId: 'shared-conversation',
      kind: 'goal',
      run: async () => { await pending; return { status: 'completed' } },
    })).toBe(true)
    expect(queue.enqueue({
      conversationId: 'shared-conversation',
      kind: 'expert',
      run: async () => ({ status: 'completed' }),
    })).toBe(false)

    release?.()
    await vi.waitFor(() => expect(queue.activeCount).toBe(0))
  })
})
