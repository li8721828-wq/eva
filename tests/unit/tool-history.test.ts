import { describe, expect, it } from 'vitest'
import { sanitizeToolHistory } from '../../src/main/agent-engine/tool-history'
import type { ChatMessage } from '../../src/shared/types/conversation'

const assistantWithTool: ChatMessage = {
  id: 'assistant-1',
  conversationId: 'conversation-1',
  role: 'assistant',
  content: 'I will inspect the project.',
  toolCalls: [{ id: 'tool-1', name: 'list_directory', arguments: {} }],
  timestamp: 1,
}

describe('sanitizeToolHistory', () => {
  it('keeps a complete assistant tool-call sequence', () => {
    const toolResult: ChatMessage = {
      id: 'tool-result-1',
      conversationId: 'conversation-1',
      role: 'tool',
      content: 'src',
      toolCallId: 'tool-1',
      timestamp: 2,
    }

    expect(sanitizeToolHistory([assistantWithTool, toolResult])).toEqual([assistantWithTool, toolResult])
  })

  it('removes incomplete tool-call metadata while retaining assistant text', () => {
    const result = sanitizeToolHistory([assistantWithTool])

    expect(result).toEqual([{ ...assistantWithTool, toolCalls: undefined }])
  })

  it('drops orphaned tool messages', () => {
    const orphan: ChatMessage = {
      id: 'tool-result-1',
      conversationId: 'conversation-1',
      role: 'tool',
      content: 'orphaned result',
      toolCallId: 'missing-tool',
      timestamp: 2,
    }

    expect(sanitizeToolHistory([orphan])).toEqual([])
  })
})
