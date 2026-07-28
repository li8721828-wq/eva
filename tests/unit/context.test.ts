import { describe, it, expect } from 'vitest'
import { ContextManager } from '../../src/main/agent-engine/context'
import type { ChatMessageInput } from '../../src/shared/types/provider'

describe('ContextManager', () => {
  const cm = new ContextManager()

  describe('estimateTokens', () => {
    it('should return ~4 chars per token', () => {
      expect(cm.estimateTokens('')).toBe(0)
      expect(cm.estimateTokens('abcd')).toBe(1)
      expect(cm.estimateTokens('abcdefgh')).toBe(2)
      expect(cm.estimateTokens('a')).toBe(1) // ceil(1/4) = 1
    })

    it('should handle empty string', () => {
      expect(cm.estimateTokens('')).toBe(0)
    })

    it('should ceil partial tokens', () => {
      // 5 chars -> ceil(5/4) = 2
      expect(cm.estimateTokens('abcde')).toBe(2)
    })
  })

  describe('trimMessages', () => {
    it('should return empty array for empty input', () => {
      expect(cm.trimMessages([], 1000)).toEqual([])
    })

    it('should always keep system message', () => {
      const msgs: ChatMessageInput[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
      ]
      const result = cm.trimMessages(msgs, 1000)
      expect(result.length).toBe(2)
      expect(result[0].role).toBe('system')
    })

    it('should trim oldest messages first when exceeding budget', () => {
      const msgs: ChatMessageInput[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'a'.repeat(100) },   // ~25 tokens
        { role: 'assistant', content: 'b'.repeat(100) }, // ~25 tokens
        { role: 'user', content: 'c'.repeat(100) },   // ~25 tokens
      ]
      // Budget: system (1 token) + 50 tokens = keeps ~2 of the 3 history msgs
      const result = cm.trimMessages(msgs, 51)
      // System + at most 2 recent messages
      expect(result.length).toBeLessThanOrEqual(3)
      expect(result[0].role).toBe('system')
      // Most recent should be kept
      expect(result[result.length - 1].content).toBe('c'.repeat(100))
    })

    it('should keep tool_call/tool_result pairs together', () => {
      const msgs: ChatMessageInput[] = [
        { role: 'system', content: 'sys' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc-1', name: 'read_file', arguments: {} }],
        },
        { role: 'tool', content: 'file content', toolCallId: 'tc-1' },
        { role: 'assistant', content: 'I read the file' },
      ]
      // Enough budget for all
      const result = cm.trimMessages(msgs, 1000)
      expect(result.length).toBe(4)

      // Tight budget that would drop the assistant tool_call but keep tool result
      // The filter should drop the orphaned tool result
      const result2 = cm.trimMessages(msgs, 10)
      // tool result without matching assistant tool_call should be dropped
      const toolMsgs = result2.filter((m) => m.role === 'tool')
      const assistantToolCalls = result2.filter(
        (m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
      )
      // Every tool message should have a corresponding assistant tool_call
      for (const toolMsg of toolMsgs) {
        const hasMatchingCall = assistantToolCalls.some(
          (a) => a.toolCalls!.some((tc) => tc.id === toolMsg.toolCallId)
        )
        expect(hasMatchingCall).toBe(true)
      }
    })

    it('should truncate system message if it alone exceeds budget', () => {
      const msgs: ChatMessageInput[] = [
        { role: 'system', content: 'x'.repeat(1000) },
        { role: 'user', content: 'hi' },
      ]
      const result = cm.trimMessages(msgs, 10)
      expect(result.length).toBe(1)
      expect(result[0].role).toBe('system')
      expect(result[0].content.length).toBe(40) // 10 tokens * 4 chars
    })
  })
})
