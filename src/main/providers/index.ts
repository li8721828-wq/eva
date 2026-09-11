import type { LLMProviderConfig } from '../../shared/types/provider'
import type { LLMProvider, ProviderCreateOptions } from './base-provider'
import { OpenAIProvider } from './openai'
import { AnthropicProvider } from './anthropic'
import { OpenCodeProvider } from './opencode'
import { inferModelCapabilities } from '../../shared/model-capabilities'
import type { ModelCapabilityProfile } from '../../shared/types/provider'

/**
 * Default base URLs for various providers.
 */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  anthropic: 'https://api.anthropic.com',
}

/**
 * Factory function: create the appropriate Provider based on config type.
 */
export function createProvider(config: LLMProviderConfig): LLMProvider {
  const options: ProviderCreateOptions = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    defaultModel: config.defaultModel,
    models: config.models,
  }

  switch (config.type) {
    case 'openai':
      return new OpenAIProvider(config.id, config.name, 'openai', {
        ...options,
        baseUrl: options.baseUrl || DEFAULT_BASE_URLS.openai,
      })

    case 'deepseek':
      return new OpenAIProvider(config.id, config.name, 'deepseek', {
        ...options,
        baseUrl: options.baseUrl || DEFAULT_BASE_URLS.deepseek,
      })

    case 'anthropic':
      return new AnthropicProvider(config.id, config.name, {
        ...options,
        baseUrl: options.baseUrl || DEFAULT_BASE_URLS.anthropic,
      })

    case 'custom':
      // OpenCode Go exposes multiple upstream API families behind one base URL.
      // Keep ordinary custom gateways on the existing OpenAI-compatible path.
      if (/opencode\.ai/i.test(options.baseUrl || '') || config.models.some((model) => Boolean(model.transport))) {
        return new OpenCodeProvider(config.id, config.name, options)
      }
      return new OpenAIProvider(config.id, config.name, 'custom', options)

    default:
      throw new Error(`Unknown provider type: ${config.type}`)
  }
}

/**
 * ProviderRegistry - manages all registered LLM providers.
 */
export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map()
  private configs: Map<string, LLMProviderConfig> = new Map()

  /**
   * Register a provider from config.
   */
  register(config: LLMProviderConfig): void {
    if (!config.isEnabled) return
    const provider = createProvider(config)
    this.providers.set(config.id, provider)
    this.configs.set(config.id, config)
  }

  /**
   * Get a provider instance by ID.
   */
  get(providerId: string): LLMProvider | undefined {
    return this.providers.get(providerId)
  }

  /**
   * List all registered provider IDs.
   */
  list(): string[] {
    return Array.from(this.providers.keys())
  }

  /**
   * Remove a provider.
   */
  unregister(providerId: string): void {
    this.providers.delete(providerId)
    this.configs.delete(providerId)
  }

  /**
   * Batch register providers from config array.
   */
  registerAll(configs: LLMProviderConfig[]): void {
    for (const config of configs) {
      this.register(config)
    }
  }

  /**
   * Get the default model for a provider.
   */
  getDefaultModel(providerId: string): string | undefined {
    return this.configs.get(providerId)?.defaultModel
  }

  /** Return the persisted profile when available, otherwise a conservative inference. */
  getModelCapabilities(providerId: string, modelId: string): ModelCapabilityProfile | undefined {
    const config = this.configs.get(providerId)
    if (!config) return undefined
    const declared = config.models.find((model) => model.id === modelId)
    if (declared?.capabilities) return declared.capabilities
    return inferModelCapabilities(config.type, modelId, declared)
  }
}

// Global singleton
export const providerRegistry = new ProviderRegistry()
