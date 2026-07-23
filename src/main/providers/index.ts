import type { LLMProviderConfig } from '../../shared/types/provider'
import type { LLMProvider, ProviderCreateOptions } from './base-provider'
import { OpenAIProvider } from './openai'
import { AnthropicProvider } from './anthropic'

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
      // Custom providers use OpenAI-compatible API format
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
}

// Global singleton
export const providerRegistry = new ProviderRegistry()
