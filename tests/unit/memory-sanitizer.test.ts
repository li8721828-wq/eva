import { describe, expect, it } from 'vitest'
import { sanitizeMemoryEvent } from '../../src/main/services/memory-sanitizer'

describe('sanitizeMemoryEvent', () => {
  it('redacts credentials before an event reaches the memory model', () => {
    const event = sanitizeMemoryEvent({
      conversationId: 'c1',
      messageId: 'm1',
      userRequest: 'Use apiKey=super-secret-value-123456 and Bearer abcdefghijklmnop.',
      assistantResult: 'The token is sk-test_abcdefghijklmnop.',
      status: 'completed',
      toolCalls: [{ name: 'read_file', resultSummary: 'password=hunter2-value' }],
    })

    expect(event.userRequest).not.toContain('super-secret-value-123456')
    expect(event.userRequest).not.toContain('abcdefghijklmnop')
    expect(event.assistantResult).not.toContain('sk-test_abcdefghijklmnop')
    expect(event.toolCalls?.[0].resultSummary).toContain('[REDACTED]')
  })
})
