import { describe, it, expect } from 'vitest'
import { ContextManager } from '../../src/main/agent-engine/context'
import type { ChatMessageInput } from '../../src/shared/types/provider'
import type { AgentConfig } from '../../src/shared/types/agent'

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

  describe('buildSystemPrompt', () => {
    it('adds evidence and action integrity guardrails for every agent', () => {
      const agent: AgentConfig = {
        id: 'test-agent',
        name: 'Test Agent',
        description: 'Test agent',
        role: 'custom',
        systemPrompt: 'Base instructions.',
        model: 'test-model',
        providerId: 'test-provider',
        tools: ['read_file', 'write_file', 'web_search'],
        maxIterations: 4,
        temperature: 0,
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
      }

      const prompt = cm.buildSystemPrompt(agent, 'C:\\workspace', undefined, false, [])

      expect(prompt).toContain('--- Evidence and Action Integrity ---')
      expect(prompt).toContain('Never invent a source')
      expect(prompt).toContain('current information could not be verified')
      expect(prompt).toContain('checked with read_file')
      expect(prompt).toContain('never for labels or isolated keywords')
      expect(prompt).toContain('render file names, table names, field names, and ordinary identifiers as normal text')
    })

    it('does not inject legacy output-format rules into the system prompt', () => {
      const agent: AgentConfig = {
        id: 'format-agent', name: 'Format Agent', description: 'Test agent', role: 'custom', systemPrompt: 'Base instructions.',
        outputFormat: 'json', model: 'test-model', providerId: 'test-provider', tools: [], maxIterations: 4,
        temperature: 0, isBuiltIn: false, createdAt: 0, updatedAt: 0,
      }

      const prompt = cm.buildSystemPrompt(agent, 'C:\\workspace', undefined, false, [])

      expect(prompt).not.toContain('--- Agent Output Format ---')
      expect(prompt).not.toContain('Return valid JSON only.')
    })
  })

  describe('long-context history', () => {
    const agent: AgentConfig = {
      id: 'long-context-agent',
      name: 'Long Context Agent',
      description: 'Test agent',
      role: 'custom',
      systemPrompt: 'Base instructions.',
      model: 'deepseek-v4-pro',
      providerId: 'deepseek',
      tools: [],
      maxIterations: 4,
      temperature: 0,
      isBuiltIn: false,
      createdAt: 0,
      updatedAt: 0,
    }

    it('keeps more than fourteen lightweight turns when the context budget allows it', () => {
      const messages = Array.from({ length: 20 }, (_, index) => ({
        id: `message-${index}`,
        conversationId: 'conversation',
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `turn ${index}`,
        timestamp: index,
      }))

      const result = cm.buildContext({
        agentConfig: agent,
        messages,
        workspacePath: 'C:\\workspace',
        tools: [],
        maxContextTokens: 900_000,
      })

      expect(result).toHaveLength(21)
      expect(result[1].content).toBe('turn 0')
    })
  })

  describe('quoted message context', () => {
    it('supplies the selected reference with the current user request', () => {
      const agent: AgentConfig = {
        id: 'quote-agent', name: 'Quote Agent', description: 'Test agent', role: 'custom', systemPrompt: 'Base instructions.',
        model: 'test-model', providerId: 'test-provider', tools: [], maxIterations: 4,
        temperature: 0, isBuiltIn: false, createdAt: 0, updatedAt: 0,
      }
      const result = cm.buildContext({
        agentConfig: agent,
        workspacePath: 'C:\\workspace',
        tools: [],
        messages: [{
          id: 'current-message', conversationId: 'conversation', role: 'user',
          content: 'Continue the task from the quoted message.', timestamp: 1,
          quotedMessage: {
            messageId: 'previous-message', role: 'assistant', content: 'Implement the account reconciliation report.',
          },
        }],
      })

      expect(result[1].content).toContain('User-selected conversation reference - required context')
      expect(result[1].content).toContain('Implement the account reconciliation report.')
      expect(result[1].content).toContain('Continue the task from the quoted message.')
    })
  })
})
