import { describe, expect, it } from 'vitest'
import { getProtocolAdapter, listProtocolAdapters } from '../../src/main/providers/protocol-adapters'

describe('model protocol adapters', () => {
  it('resolves provider/model protocol consistently', () => {
    expect(getProtocolAdapter('openai', 'gpt-4o').protocol).toBe('openai-tools')
    expect(getProtocolAdapter('anthropic', 'claude-sonnet-4').protocol).toBe('anthropic-tools')
    expect(getProtocolAdapter('custom', 'deepseek-v4-flash').protocol).toBe('deepseek-dsml')
    expect(getProtocolAdapter('custom', 'vendor-chat').protocol).toBe('unknown')
  })

  it('keeps text recovery enabled only for protocols that define it', () => {
    expect(getProtocolAdapter('anthropic', 'claude-3-5-haiku').textToolCalls).toBe(false)
    expect(getProtocolAdapter('deepseek', 'deepseek-v4-flash').textToolCalls).toBe(true)
    expect(listProtocolAdapters().map((adapter) => adapter.protocol)).toEqual(expect.arrayContaining([
      'openai-tools', 'anthropic-tools', 'deepseek-dsml', 'unknown',
    ]))
  })
})
