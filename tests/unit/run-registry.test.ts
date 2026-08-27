import { describe, expect, it } from 'vitest'
import { RunRegistry } from '../../src/main/services/run-registry'

describe('RunRegistry', () => {
  it('isolates handles by both conversation and runtime kind', () => {
    const registry = new RunRegistry()
    const chat = registry.forKind<{ id: string }>('chat')
    const goal = registry.forKind<{ id: string }>('task-goal')

    chat.set('conversation-1', { id: 'chat-run' })
    goal.set('conversation-1', { id: 'goal-run' })

    expect(chat.get('conversation-1')).toEqual({ id: 'chat-run' })
    expect(goal.get('conversation-1')).toEqual({ id: 'goal-run' })
    expect(registry.list('conversation-1')).toHaveLength(2)
  })

  it('removes all transient handles when a conversation is cleared', () => {
    const registry = new RunRegistry()
    registry.forKind('chat').set('conversation-1', { abort: () => undefined })
    registry.forKind('task-goal').set('conversation-1', { abort: () => undefined })
    registry.forKind('chat').set('conversation-2', { abort: () => undefined })

    registry.clearConversation('conversation-1')

    expect(registry.list('conversation-1')).toEqual([])
    expect(registry.list('conversation-2')).toHaveLength(1)
  })

  it('records lifecycle transitions separately from the handle', () => {
    const registry = new RunRegistry()
    registry.forKind('task-goal').set('conversation-1', { abort: () => undefined })
    registry.transition('task-goal', 'conversation-1', 'paused', 'Waiting for user guidance.')

    expect(registry.list('conversation-1')[0]).toMatchObject({ status: 'paused', detail: 'Waiting for user guidance.' })
  })

  it('supports requirement-engineering runs alongside chat and task execution', () => {
    const registry = new RunRegistry()
    registry.forKind('requirement').set('conversation-1', { abort: () => undefined })
    registry.transition('requirement', 'conversation-1', 'cancelling', 'User requested cancellation.')

    expect(registry.list('conversation-1')[0]).toMatchObject({ kind: 'requirement', status: 'cancelling' })
  })
})
