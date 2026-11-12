import { describe, expect, it } from 'vitest'
import { inferModelCapabilities, mergeProbedCapabilities, resolveModelOutputBudget, supportsImageInput } from '../../src/shared/model-capabilities'

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

describe('model output budget', () => {
  const profile = inferModelCapabilities('custom', 'deepseek-v4-flash')
  const harness = { id: 'deepseek-harness' as const }

  it('keeps legacy defaults and clamps a model override to the connection limit', () => {
    expect(resolveModelOutputBudget(profile, harness, true)).toBe(16_384)
    expect(resolveModelOutputBudget(profile, undefined, true)).toBe(8_192)
    const configured = { ...profile, outputTokenBudget: 65_536, maxOutputTokens: 32_768 }
    expect(resolveModelOutputBudget(configured, harness, true)).toBe(32_768)
    expect(resolveModelOutputBudget(configured, undefined, false)).toBe(32_768)
    expect(resolveModelOutputBudget({ ...configured, contextWindowTokens: 32_000 }, harness, true)).toBe(8_000)
  })

  it('preserves output metadata and overrides across tool probes', () => {
    const configured = { ...profile, outputTokenBudget: 24_000, maxOutputTokens: 32_000 }
    expect(mergeProbedCapabilities(configured, profile)).toMatchObject({
      outputTokenBudget: 24_000,
      maxOutputTokens: 32_000,
    })
  })
})

describe('probe result merging', () => {
  const previous = { ...inferModelCapabilities('custom', 'gateway-model'), supportsTools: true, source: 'probed' as const, probeStatus: 'supported' as const }

  it('keeps a previously confirmed capability when a retry is inconclusive', () => {
    const probed = { ...inferModelCapabilities('custom', 'gateway-model', { supportsTools: true }), source: 'probed' as const, probeStatus: 'inconclusive' as const, lastError: 'HTTP 503' }
    const merged = mergeProbedCapabilities(previous, probed)
    expect(merged.supportsTools).toBe(true)
    expect(merged.probeStatus).toBe('supported')
    expect(merged.lastError).toBe('HTTP 503')
  })

  it('accepts a definitive verdict even when one already existed', () => {
    const probed = { ...inferModelCapabilities('custom', 'gateway-model', { supportsTools: false }), source: 'probed' as const, probeStatus: 'unsupported' as const }
    expect(mergeProbedCapabilities(previous, probed).supportsTools).toBe(false)
    expect(mergeProbedCapabilities(previous, probed).probeStatus).toBe('unsupported')
  })

  it('leaves an unconfirmed route unconfirmed when nothing was known before', () => {
    const probed = { ...inferModelCapabilities('custom', 'gateway-model'), supportsTools: undefined, source: 'probed' as const, probeStatus: 'inconclusive' as const }
    expect(mergeProbedCapabilities(undefined, probed).supportsTools).toBeUndefined()
  })
})

describe('image input gate', () => {
  it('accepts images on a route the profile marks as visual', () => {
    expect(supportsImageInput(inferModelCapabilities('deepseek', 'deepseek-v4-flash-vision-exp'))).toBe(true)
    expect(supportsImageInput(inferModelCapabilities('openai', 'gpt-4o'))).toBe(true)
  })

  it('keeps a text-only checkpoint out of image turns', () => {
    expect(supportsImageInput(inferModelCapabilities('deepseek', 'deepseek-v4-flash'))).toBe(false)
    expect(supportsImageInput(inferModelCapabilities('custom', 'gateway-model'))).toBe(false)
  })

  it('lets a declared value decide instead of the model name', () => {
    expect(supportsImageInput(inferModelCapabilities('openai', 'gpt-4o', { supportsVision: false }))).toBe(false)
    expect(supportsImageInput(inferModelCapabilities('custom', 'gateway-model', { supportsVision: true }))).toBe(true)
  })

  it('uses the saved image-input choice before capability defaults', () => {
    const visual = inferModelCapabilities('anthropic', 'claude-opus-4-6-thinking')
    const unknown = inferModelCapabilities('custom', 'gateway-model')
    expect(supportsImageInput({ ...visual, visionEnabled: false })).toBe(false)
    expect(supportsImageInput({ ...unknown, visionEnabled: true })).toBe(true)
  })

  it('keeps image metadata and the user preference after a tool probe', () => {
    const declared = inferModelCapabilities('custom', 'gateway-model', { supportsVision: true })
    const toolProbe = { ...inferModelCapabilities('custom', 'gateway-model'), probeStatus: 'supported' as const }
    expect(mergeProbedCapabilities(declared, toolProbe).supportsVision).toBe(true)
    const merged = mergeProbedCapabilities({ ...declared, visionEnabled: false }, toolProbe)
    expect(merged.supportsVision).toBe(true)
    expect(supportsImageInput(merged)).toBe(false)
  })

  it('trusts the Anthropic family without requiring a declaration', () => {
    expect(supportsImageInput(inferModelCapabilities('anthropic', 'claude-opus-4-6-thinking'))).toBe(true)
  })
})
