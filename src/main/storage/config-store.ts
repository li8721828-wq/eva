import Store from 'electron-store'
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
} from '../../shared/constants'
import type { ProviderConfigEntry } from '../../shared/types/provider'
import type { FileAccessGrant } from '../../shared/types/file-access'
import type { AutomationConfig } from '../../shared/types/automation'
import { DEFAULT_AUTOMATION_CONFIG } from '../../shared/types/automation'
import type { ModelRateCard } from '../../shared/types/cost'
import type { ModelPool, ModelPoolEntry } from '../../shared/types/model-pool'
import { CredentialStore } from './credential-store'

export type { ProviderConfigEntry }

export interface AppConfig {
  // General
  theme: 'dark' | 'light'
  language: 'en' | 'zh' | 'ja'
  workspacePath: string
  fileAccessGrants: FileAccessGrant[]
  sidebarCollapsed: boolean
  terminalVisible: boolean
  rightPanelVisible: boolean

  // Model config
  providers: ProviderConfigEntry[]
  activeProviderId: string
  activeModel: string
  modelPools: ModelPool[]
  /** @deprecated Legacy singleton pool, migrated into modelPools on startup. */
  modelPool?: ModelPoolEntry[]

  // Advanced
  maxIterations: number
  temperature: number
  maxTokens: number
  automation: AutomationConfig
  costRateCards: ModelRateCard[]
}

const DEFAULT_PROVIDERS: ProviderConfigEntry[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    apiKey: '',
    isEnabled: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    apiKey: '',
    isEnabled: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'deepseek',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    isEnabled: false,
  },
]

const DEFAULTS: AppConfig = {
  theme: 'light',
  language: 'en',
  workspacePath: '',
  fileAccessGrants: [],
  sidebarCollapsed: false,
  terminalVisible: true,
  rightPanelVisible: true,
  providers: DEFAULT_PROVIDERS,
  activeProviderId: 'openai',
  activeModel: 'gpt-4o',
  modelPools: [],
  maxIterations: DEFAULT_MAX_ITERATIONS,
  temperature: DEFAULT_TEMPERATURE,
  maxTokens: DEFAULT_MAX_TOKENS,
  automation: DEFAULT_AUTOMATION_CONFIG,
  costRateCards: [],
}

export class ConfigStore {
  private store: Store<AppConfig>
  private credentials = new CredentialStore()

  constructor() {
    this.store = new Store<AppConfig>({
      name: 'config',
      defaults: DEFAULTS,
    })
    this.migrateProviderCredentials()
    this.migrateModelPools()
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.store.get(key)
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.store.set(key, value)
  }

  getAll(): AppConfig {
    // Generic configuration reads never need credential material. The explicit
    // provider API hydrates keys only for the Settings editor and provider setup.
    return {
      ...this.store.store,
      providers: this.store.get('providers').map((provider) => ({ ...provider, apiKey: '' })),
    }
  }

  setAll(config: Partial<AppConfig>): void {
    this.store.set(config)
  }

  // Provider configuration management
  getProviders(): ProviderConfigEntry[] {
    return this.store.get('providers').map((provider) => ({
      ...provider,
      apiKey: this.credentials.get(this.providerCredentialKey(provider.id)),
    }))
  }

  getProvider(id: string): ProviderConfigEntry | undefined {
    return this.getProviders().find((provider) => provider.id === id)
  }

  saveProvider(provider: ProviderConfigEntry): void {
    const providers = this.store.get('providers')
    const apiKey = provider.apiKey.trim()
    if (apiKey) this.credentials.set(this.providerCredentialKey(provider.id), apiKey)
    const storedProvider = { ...provider, apiKey: '' }
    const index = providers.findIndex((p) => p.id === provider.id)
    if (index >= 0) {
      providers[index] = storedProvider
    } else {
      providers.push(storedProvider)
    }
    this.store.set('providers', providers)
  }

  deleteProvider(id: string): void {
    const providers = this.store.get('providers')
    const filtered = providers.filter((p) => p.id !== id)
    this.store.set('providers', filtered)
    this.credentials.delete(this.providerCredentialKey(id))
  }

  getActiveProvider(): ProviderConfigEntry | undefined {
    const activeId = this.store.get('activeProviderId')
    return this.getProvider(activeId)
  }

  getActiveModel(): string {
    return this.store.get('activeModel')
  }

  private providerCredentialKey(id: string): string {
    return `provider:${id}`
  }

  private migrateProviderCredentials(): void {
    const providers = this.store.get('providers')
    if (!this.credentials.isAvailable() || !providers.some((provider) => provider.apiKey)) return

    const migrated = providers.map((provider) => {
      if (!provider.apiKey) return provider
      this.credentials.set(this.providerCredentialKey(provider.id), provider.apiKey)
      return { ...provider, apiKey: '' }
    })
    this.store.set('providers', migrated)
  }

  private migrateModelPools(): void {
    const pools = this.store.get('modelPools') || []
    const legacyEntries = this.store.get('modelPool') || []
    if (pools.length || !legacyEntries.length) return
    this.store.set('modelPools', [{ id: 'default-model-pool', name: 'Default model pool', entries: legacyEntries }])
  }
}
