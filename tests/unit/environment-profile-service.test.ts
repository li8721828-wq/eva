import { describe, expect, it } from 'vitest'
import { buildSharedEnvironmentPrompt, normalizeEnvironmentRules } from '../../src/main/services/environment-profile-service'

describe('environment profile service', () => {
  it('keeps enabled rules in a bounded shared prompt', () => {
    const config = normalizeEnvironmentRules({
      enabled: true,
      maxTokens: 180,
      rules: [
        { id: 'custom', title: 'Custom rule', content: 'Use the configured shell syntax.', scope: 'all', source: 'user', enabled: true, occurrences: 1, createdAt: 1, updatedAt: 1 },
      ],
    })
    const prompt = buildSharedEnvironmentPrompt(config)

    expect(prompt).toContain('Shared Runtime Environment')
    expect(prompt).toContain('Custom rule')
  })

  it('normalizes malformed persisted values to safe defaults', () => {
    const config = normalizeEnvironmentRules({ enabled: false, maxTokens: 99, rules: [{ id: 'bad' }] })

    expect(config.enabled).toBe(false)
    expect(config.maxTokens).toBe(120)
    expect(config.rules.length).toBeGreaterThan(0)
  })
})
