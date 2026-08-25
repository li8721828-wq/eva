import { describe, expect, it } from 'vitest'
import {
  TOOL_FOLLOW_UP_INPUT_BUDGET_TOKENS,
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
})
