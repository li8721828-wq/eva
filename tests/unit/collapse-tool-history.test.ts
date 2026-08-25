import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import { collapseToolHistoryMessages } from '../../src/renderer/lib/collapse-tool-history'

const base = { conversationId: 'goal-step', timestamp: 1, agentName: 'Coding Assistant' }

describe('collapseToolHistoryMessages', () => {
  it('combines persisted Goal tool events into one activity item', () => {
    const messages: ChatMessage[] = [
      { ...base, id: 'call-1', role: 'assistant', content: '', toolCalls: [{ id: 'tool-1', name: 'web_search', arguments: { query: 'one' } }] },
      { ...base, id: 'result-1', role: 'tool', content: 'first result', toolCallId: 'tool-1' },
      { ...base, id: 'call-2', role: 'assistant', content: '', toolCalls: [{ id: 'tool-2', name: 'read_web_page', arguments: { url: 'https://example.com' } }] },
      { ...base, id: 'result-2', role: 'tool', content: 'second result', toolCallId: 'tool-2' },
      { ...base, id: 'final', role: 'assistant', content: 'Step completed.' },
    ]

    const result = collapseToolHistoryMessages(messages)

    expect(result).toHaveLength(2)
    expect(result[0].toolCalls).toEqual([
      expect.objectContaining({ id: 'tool-1', result: 'first result' }),
      expect.objectContaining({ id: 'tool-2', result: 'second result' }),
    ])
    expect(result[1].content).toBe('Step completed.')
  })

  it('does not combine a real assistant reply that also contains tool metadata', () => {
    const messages: ChatMessage[] = [{
      ...base,
      id: 'reply',
      role: 'assistant',
      content: 'Here is the completed answer.',
      toolCalls: [{ id: 'tool-1', name: 'read_file', arguments: {} }],
    }]

    expect(collapseToolHistoryMessages(messages)).toEqual(messages)
  })

  it('attaches persisted progress updates to the final assistant reply', () => {
    const messages: ChatMessage[] = [
      { ...base, id: 'progress-1', role: 'assistant', content: 'Checking the disk usage first.', progressKind: 'thinking' },
      { ...base, id: 'progress-2', role: 'assistant', content: 'The first shell approach needs adjustment.', progressKind: 'issue' },
      { ...base, id: 'final', role: 'assistant', content: 'Here is the completed analysis.' },
    ]

    const result = collapseToolHistoryMessages(messages)

    expect(result).toHaveLength(1)
    expect(result[0].progressUpdates).toEqual([
      expect.objectContaining({ id: 'progress-1', kind: 'thinking' }),
      expect.objectContaining({ id: 'progress-2', kind: 'issue' }),
    ])
  })
})
