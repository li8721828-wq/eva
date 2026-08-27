import { describe, expect, it } from 'vitest'
import { buildProviderProfile, providerValidationError } from '../../src/renderer/lib/provider-profile'

describe('provider profile helpers', () => {
  const base = { id: 'p', name: 'Provider', type: 'openai' as const, apiKey: 'key', defaultModel: 'm', isEnabled: true, selectedModelIds: ['m'], availableModels: [{ id: 'm', name: 'Model' }] }
  it('validates a saved provider profile', () => expect(providerValidationError(base, true)).toBeNull())
  it('builds only selected provider models', () => expect(buildProviderProfile(base).models).toEqual([{ id: 'm', name: 'Model' }]))
})
