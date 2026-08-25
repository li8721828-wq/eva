import { describe, it, expect } from 'vitest'
import { ContextManager } from '../../src/main/agent-engine/context'
import type { ChatMessageInput } from '../../src/shared/types/provider'
import type { AgentConfig } from '../../src/shared/types/agent'
import { DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS, getModelContextWindowTokens } from '../../src/shared/constants'

describe('ContextManager', () => {
  const cm = new ContextManager()

  it('recognizes configured DeepSeek V4 gateway model variants', () => {
    expect(getModelContextWindowTokens('deepseek-v4-flash-ga-260731')).toBe(DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS)
  })

  describe('estimateTokens', () => {
    it('uses a conservative multilingual estimate', () => {
      expect(cm.estimateTokens('')).toBe(0)
      expect(cm.estimateTokens('abcdefgh')).toBeGreaterThan(0)
      expect(cm.estimateTokens('中文上下文')).toBeGreaterThan(cm.estimateTokens('abcdef'))
      expect(cm.estimateTokens('{"path":"src/a.ts","ok":true}')).toBeGreaterThan(0)
    })

    it('should handle empty string', () => {
      expect(cm.estimateTokens('')).toBe(0)
    })

    it('should ceil partial tokens', () => {
      expect(cm.estimateTokens('abcde')).toBeGreaterThanOrEqual(1)
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
      expect(cm.estimateTokens(result[0].content)).toBeLessThanOrEqual(10)
    })

    it('keeps a multi-tool exchange as a complete transaction when compacting', () => {
      const msgs: ChatMessageInput[] = [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: '', toolCalls: [
          { id: 'tc-a', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'tc-b', name: 'read_file', arguments: { path: 'b.ts' } },
        ] },
        { role: 'tool', content: JSON.stringify({ status: 'ok', path: 'a.ts', result: 'a'.repeat(1000) }), toolCallId: 'tc-a' },
        { role: 'tool', content: JSON.stringify({ status: 'error', path: 'b.ts', error: 'missing export', result: 'b'.repeat(1000) }), toolCallId: 'tc-b' },
      ]
      const result = cm.trimMessages(msgs, 300)
      expect(result.filter((message) => message.role === 'tool')).toHaveLength(2)
      expect(result.find((message) => message.role === 'assistant')?.toolCalls).toHaveLength(2)
      expect(result.some((message) => message.content.includes('missing export'))).toBe(true)
    })

    it('does not forward an incomplete tool transaction', () => {
      const result = cm.trimMessages([
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: '', toolCalls: [
          { id: 'tc-a', name: 'read_file', arguments: {} },
          { id: 'tc-b', name: 'read_file', arguments: {} },
        ] },
        { role: 'tool', content: 'only one result', toolCallId: 'tc-a' },
        { role: 'user', content: 'Current request' },
      ], 500)
      expect(result.some((message) => message.role === 'tool')).toBe(false)
      expect(result.some((message) => message.toolCalls?.length)).toBe(false)
      expect(result.at(-1)?.content).toBe('Current request')
    })

    it('keeps the current request when older history exhausts the budget', () => {
      const msgs: ChatMessageInput[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'old context '.repeat(200) },
        { role: 'assistant', content: 'old response '.repeat(200) },
        { role: 'user', content: 'Current request: fix the payment timeout.' },
      ]
      const result = cm.trimMessages(msgs, 40)
      expect(result.at(-1)?.content).toContain('Current request')
      expect(result.some((message) => message.content.includes('old response'))).toBe(false)
    })

    it('reports its local budget decisions', () => {
      cm.fitMessages([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Current request' },
      ], 100, [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }])
      expect(cm.getLastDiagnostics()).toMatchObject({ budgetTokens: 100, retainedMessages: 1, estimator: 'heuristic-v2' })
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

    it('keeps the conclusion at the end of a long quoted reference', () => {
      const agent: AgentConfig = {
        id: 'quote-agent', name: 'Quote Agent', description: 'Test agent', role: 'custom', systemPrompt: 'Base instructions.',
        model: 'test-model', providerId: 'test-provider', tools: [], maxIterations: 4,
        temperature: 0, isBuiltIn: false, createdAt: 0, updatedAt: 0,
      }
      const result = cm.buildContext({
        agentConfig: agent, workspacePath: 'C:\\workspace', tools: [],
        messages: [{
          id: 'current-message', conversationId: 'conversation', role: 'user', content: 'Continue.', timestamp: 1,
          quotedMessage: { messageId: 'previous-message', role: 'assistant', content: `${'analysis '.repeat(3_000)}FINAL CONCLUSION: retain this.` },
        }],
      })
      expect(result[1].content).toContain('FINAL CONCLUSION: retain this.')
    })
  })
})
