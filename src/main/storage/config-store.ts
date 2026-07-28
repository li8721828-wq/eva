import Store from 'electron-store'
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
} from '../../shared/constants'
import type { ProviderConfigEntry } from '../../shared/types/provider'
import type { FileAccessGrant } from '../../shared/types/file-access'

export type { ProviderConfigEntry }

export interface AppConfig {
  // General
  theme: 'dark' | 'light'
  language: 'en' | 'zh'
  workspacePath: string
  fileAccessGrants: FileAccessGrant[]
  sidebarCollapsed: boolean
  terminalVisible: boolean
  rightPanelVisible: boolean

  // Model config
  providers: ProviderConfigEntry[]
  activeProviderId: string
  activeModel: string

  // Advanced
  maxIterations: number
  temperature: number
  maxTokens: number
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
  maxIterations: DEFAULT_MAX_ITERATIONS,
  temperature: DEFAULT_TEMPERATURE,
  maxTokens: DEFAULT_MAX_TOKENS,
}

export class ConfigStore {
  private store: Store<AppConfig>

  constructor() {
    this.store = new Store<AppConfig>({
      name: 'config',
      defaults: DEFAULTS,
    })
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.store.get(key)
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.store.set(key, value)
  }

  getAll(): AppConfig {
    return this.store.store
  }

  setAll(config: Partial<AppConfig>): void {
    this.store.set(config)
  }

  // Provider configuration management
  getProviders(): ProviderConfigEntry[] {
    return this.store.get('providers')
  }

  getProvider(id: string): ProviderConfigEntry | undefined {
    const providers = this.store.get('providers')
    return providers.find((p) => p.id === id)
  }

  saveProvider(provider: ProviderConfigEntry): void {
    const providers = this.store.get('providers')
    const index = providers.findIndex((p) => p.id === provider.id)
    if (index >= 0) {
      providers[index] = provider
    } else {
      providers.push(provider)
    }
    this.store.set('providers', providers)
  }

  deleteProvider(id: string): void {
    const providers = this.store.get('providers')
    const filtered = providers.filter((p) => p.id !== id)
    this.store.set('providers', filtered)
  }

  getActiveProvider(): ProviderConfigEntry | undefined {
    const activeId = this.store.get('activeProviderId')
    return this.getProvider(activeId)
  }

  getActiveModel(): string {
    return this.store.get('activeModel')
  }
}
