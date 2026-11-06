import { describe, expect, it } from 'vitest'
import { inferModelCapabilities } from '../../src/shared/model-capabilities'
import { failedProbeProfile, isDefinitiveToolRejection, isTransientProbeFailure } from '../../src/main/services/model-capability-probe'

const inferred = inferModelCapabilities('custom', 'gpt-image-2.6', { maxTokens: 128_000, supportsTools: true, supportsStreaming: true })

describe('tool capability probe classification', () => {
  it('treats an explicit tool rejection as a definitive "unsupported" verdict', () => {
    const error = Object.assign(new Error('tools are not supported for this model'), { status: 400 })
    expect(isDefinitiveToolRejection(error)).toBe(true)
    const profile = failedProbeProfile(inferred, error, 'tools are not supported for this model')
    expect(profile.supportsTools).toBe(false)
    expect(profile.probeStatus).toBe('unsupported')
    expect(profile.lastError).toContain('not supported')
  })

  it.each([503, 502, 429, 500, undefined])('keeps an HTTP %s failure inconclusive', (status) => {
    const error = Object.assign(new Error('service temporarily unavailable'), status ? { status } : {})
    expect(isDefinitiveToolRejection(error)).toBe(false)
    const profile = failedProbeProfile(inferred, error, 'service temporarily unavailable')
    expect(profile.supportsTools).toBeUndefined()
    expect(profile.probeStatus).toBe('inconclusive')
  })

  it('does not read an unrelated validation error as a tool verdict', () => {
    const error = Object.assign(new Error('image size must be one of 1024x1024'), { status: 400 })
    expect(isDefinitiveToolRejection(error)).toBe(false)
  })

  it('requires both a client error and an explicit tool mention', () => {
    expect(isDefinitiveToolRejection(Object.assign(new Error('invalid api key'), { status: 401 }))).toBe(false)
    expect(isDefinitiveToolRejection(new Error('tools are not supported'))).toBe(false)
  })

  it('recognizes stored verdicts that came from a transient incident', () => {
    expect(isTransientProbeFailure('HTTP 503 服务暂时不可用')).toBe(true)
    expect(isTransientProbeFailure('The request timed out after 20 seconds.')).toBe(true)
    expect(isTransientProbeFailure('fetch failed')).toBe(true)
    expect(isTransientProbeFailure('tools are not supported')).toBe(false)
    expect(isTransientProbeFailure(undefined)).toBe(false)
  })
})
