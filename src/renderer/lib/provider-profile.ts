import type { ProviderConfigEntry, ProviderModelOption, ProviderTestConfig } from '../../shared/types/provider'

export function providerValidationError(config: ProviderTestConfig, requireModel: boolean): string | null {
  if (!config.name) return 'Enter a name for this saved connection.'
  if (!config.apiKey) return 'Enter an API key before saving.'
  if (config.type === 'custom' && !config.baseUrl) return 'Enter a base URL for a custom provider.'
  if (requireModel && !config.defaultModel) return 'Select at least one model for this connection.'
  return null
}

export function buildProviderProfile(input: ProviderTestConfig & { pricingGroup?: string; isEnabled: boolean; selectedModelIds: string[]; availableModels: ProviderModelOption[] }): ProviderConfigEntry {
  return {
    id: input.id,
    name: input.name,
    type: input.type,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    pricingGroup: input.pricingGroup?.trim() || undefined,
    isEnabled: input.isEnabled,
    defaultModel: input.defaultModel,
    models: input.availableModels.filter((model) => input.selectedModelIds.includes(model.id)),
  }
}
