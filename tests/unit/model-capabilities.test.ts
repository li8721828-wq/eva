import { describe, expect, it } from 'vitest'
import { inferModelCapabilities } from '../../src/shared/model-capabilities'

describe('model capability profiles', () => {
  it('identifies DeepSeek reasoning and large context routes', () => {
    const profile = inferModelCapabilities('deepseek', 'deepseek-v4-flash-ga-260731')
    expect(profile.protocol).toBe('deepseek-dsml')
    expect(profile.supportsTools).toBe(true)
    expect(profile.supportsReasoning).toBe(true)
    expect(profile.contextWindowTokens).toBe(1_000_000)
  })

  it('does not overclaim capabilities for custom gateways', () => {
    const profile = inferModelCapabilities('custom', 'gateway-model')
    expect(profile.protocol).toBe('unknown')
    expect(profile.supportsTools).toBeUndefined()
    expect(profile.supportsVision).toBe(false)
  })

  it('blocks known non-chat model families from tool execution', () => {
    const profile = inferModelCapabilities('openai', 'text-embedding-3-large')
    expect(profile.supportsTools).toBe(false)
    expect(profile.supportsStreaming).toBe(false)
  })

  it('honors declared provider metadata over inference', () => {
    const profile = inferModelCapabilities('custom', 'gateway-model', {
      supportsTools: true,
      supportsVision: true,
      protocol: 'openai-tools',
      maxTokens: 32_000,
    })
    expect(profile.source).toBe('declared')
    expect(profile.supportsTools).toBe(true)
    expect(profile.supportsVision).toBe(true)
    expect(profile.protocol).toBe('openai-tools')
    expect(profile.contextWindowTokens).toBe(32_000)
  })

  it('does not let a legacy 128K fallback hide DeepSeek 1M context', () => {
    const profile = inferModelCapabilities('deepseek', 'deepseek-chat', {
      maxTokens: 128_000,
      supportsTools: true,
      supportsStreaming: true,
    })
    expect(profile.contextWindowTokens).toBe(1_000_000)
  })

  it('keeps explicit context metadata authoritative', () => {
    const profile = inferModelCapabilities('deepseek', 'deepseek-chat', {
      maxTokens: 128_000,
      contextWindowTokens: 256_000,
    })
    expect(profile.contextWindowTokens).toBe(256_000)
  })
})
