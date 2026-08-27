import { describe, expect, it } from 'vitest'
import {
  TOOL_FOLLOW_UP_INPUT_BUDGET_TOKENS,
  appendRollingToolEvidence,
  compactCompletedToolTransactions,
  compactToolResultForModel,
  getToolFollowUpInputBudget,
} from '../../src/main/agent-engine/tool-result-context'

describe('tool result context', () => {
  it('keeps short results intact', () => {
    expect(compactToolResultForModel('web_search', 'one relevant source')).toBe('one relevant source')
  })

  it('bounds large research output while preserving its beginning and conclusion', () => {
    const result = `first source\n${'evidence '.repeat(2_000)}\nfinal source`
    const compacted = compactToolResultForModel('web_search', result)

    expect(compacted.length).toBeLessThanOrEqual(2_600)
    expect(compacted).toContain('Full output remains in the execution record.')
    expect(compacted).toContain('first source')
    expect(compacted).toContain('final source')
  })

  it('only applies the transport budget after tool history exists', () => {
    expect(getToolFollowUpInputBudget(900_000, false)).toBe(900_000)
    expect(getToolFollowUpInputBudget(900_000, true)).toBe(TOOL_FOLLOW_UP_INPUT_BUDGET_TOKENS)
    expect(getToolFollowUpInputBudget(16_000, true)).toBe(16_000)
  })

  it('replaces older complete tool transactions with bounded evidence', () => {
    const messages = [
      { role: 'system' as const, content: 'System' },
      { role: 'user' as const, content: 'Find evidence' },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'old', name: 'search_files', arguments: {} }] },
      { role: 'tool' as const, toolCallId: 'old', content: `old-result-${'x'.repeat(2_000)}` },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'latest', name: 'read_file', arguments: {} }] },
      { role: 'tool' as const, toolCallId: 'latest', content: 'latest-result' },
    ]

    const compacted = compactCompletedToolTransactions(messages)

    expect(compacted.messages.some((message) => message.toolCallId === 'old')).toBe(false)
    expect(compacted.messages.some((message) => message.toolCallId === 'latest')).toBe(true)
    expect(compacted.evidence).toHaveLength(1)
    expect(compacted.evidence[0]).toContain('search_files')
    expect(compacted.evidence[0].length).toBeLessThanOrEqual(1_300)
  })

  it('bounds rolling evidence while retaining the newest entries', () => {
    const evidence = appendRollingToolEvidence('', Array.from({ length: 8 }, (_, index) => `entry-${index}-${'x'.repeat(1_000)}`))
    expect(evidence.length).toBeLessThanOrEqual(6_000)
    expect(evidence).toContain('entry-7')
  })
})
