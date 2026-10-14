import { describe, expect, it } from 'vitest'
import { buildProviderProfile, computeModelStamp, providerValidationError } from '../../src/renderer/lib/provider-profile'

describe('provider profile helpers', () => {
  const base = { id: 'p', name: 'Provider', type: 'openai' as const, apiKey: 'key', defaultModel: 'm', isEnabled: true, selectedModelIds: ['m'], availableModels: [{ id: 'm', name: 'Model' }] }
  it('validates a saved provider profile', () => expect(providerValidationError(base, true)).toBeNull())
  it('builds only selected provider models', () => expect(buildProviderProfile(base).models).toEqual([{ id: 'm', name: 'Model' }]))
  it('keeps a manually entered model when the provider has no model list', () => {
    const profile = buildProviderProfile({ ...base, defaultModel: 'gateway/model-x', selectedModelIds: [], availableModels: [] })
    expect(profile).toMatchObject({
      defaultModel: 'gateway/model-x',
      models: [{ id: 'gateway/model-x', name: 'gateway/model-x' }],
    })
  })

  const credentials = { type: 'openai' as const, apiKey: 'sk-live-abcdef123456', baseUrl: 'https://api.openai.com/v1' }
  it('stamps the credentials a model list was fetched with', () => {
    expect(computeModelStamp(credentials)).toBe(computeModelStamp({ ...credentials }))
    expect(computeModelStamp({ ...credentials, apiKey: 'sk-live-abcdef123457' })).not.toBe(computeModelStamp(credentials))
    expect(computeModelStamp({ ...credentials, baseUrl: 'https://other.example.com/v1' })).not.toBe(computeModelStamp(credentials))
    expect(computeModelStamp({ ...credentials, baseUrl: '  https://api.openai.com/v1  ' })).toBe(computeModelStamp(credentials))
    expect(computeModelStamp({ ...credentials, baseUrl: undefined })).not.toBe(computeModelStamp(credentials))
  })
  it('never repeats the API key in the model stamp', () => {
    const stamp = computeModelStamp(credentials)
    expect(stamp).not.toContain(credentials.apiKey)
    expect(stamp).not.toContain('abcdef123456')
    expect(stamp).toMatch(/^[0-9a-f]{8}$/)
  })
})
