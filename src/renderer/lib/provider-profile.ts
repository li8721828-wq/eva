import type { ProviderConfigEntry, ProviderModelOption, ProviderTestConfig } from '../../shared/types/provider'

export function providerValidationError(config: ProviderTestConfig, requireModel: boolean): string | null {
  if (!config.name) return 'Enter a name for this saved connection.'
  if (!config.apiKey) return 'Enter an API key before saving.'
  if (config.type === 'custom' && !config.baseUrl) return 'Enter a base URL for a custom provider.'
  if (requireModel && !config.defaultModel.trim()) return 'Enter a model name for this connection.'
  return null
}

/**
 * A fetched model list belongs to the credentials that produced it. This is a one-way digest so a
 * staleness check never copies the API key into another state field.
 */
export function computeModelStamp(credentials: { type: ProviderConfigEntry['type']; baseUrl?: string; apiKey: string }): string {
  const source = `${credentials.type}\n${(credentials.baseUrl || '').trim()}\n${credentials.apiKey}`
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function buildProviderProfile(input: ProviderTestConfig & { pricingGroup?: string; isEnabled: boolean; selectedModelIds: string[]; availableModels: ProviderModelOption[] }): ProviderConfigEntry {
  const defaultModel = input.defaultModel.trim()
  const selectedModels = input.availableModels.filter((model) => input.selectedModelIds.includes(model.id))
  const models = defaultModel && !selectedModels.some((model) => model.id === defaultModel)
    ? [{ id: defaultModel, name: defaultModel }, ...selectedModels]
    : selectedModels
  return {
    id: input.id,
    name: input.name,
    type: input.type,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    pricingGroup: input.pricingGroup?.trim() || undefined,
    isEnabled: input.isEnabled,
    defaultModel,
    models,
  }
}
