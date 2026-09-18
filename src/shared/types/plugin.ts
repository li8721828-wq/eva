export type PluginCategory = 'integration' | 'automation' | 'research' | 'developer-tools'

export type PluginPermission =
  | 'filesystem-read'
  | 'filesystem-write'
  | 'terminal'
  | 'network'

export type PluginSettingValue = string | number | boolean

export interface PluginConfigField {
  key: string
  label: string
  description?: string
  type: 'text' | 'secret' | 'path-file' | 'path-directory' | 'number' | 'select'
  required?: boolean
  placeholder?: string
  options?: Array<{ value: string; label: string }>
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author: string
  category: PluginCategory
  permissions: PluginPermission[]
  homepage?: string
  configuration?: PluginConfigField[]
}

export interface InstalledPlugin extends PluginManifest {
  enabled: boolean
  source: 'marketplace' | 'local'
  sourcePath?: string
  settings: Record<string, PluginSettingValue>
  installedAt: string
  updatedAt: string
}

export interface MarketplacePlugin extends PluginManifest {
  verified: boolean
  requirements?: string
}

export interface MarketplacePluginView extends MarketplacePlugin {
  installedPlugin?: InstalledPlugin
}

/** State for Eva's optional localhost-only SearXNG service. */
export interface LocalSearxngStatus {
  dockerAvailable: boolean
  installed: boolean
  running: boolean
  configuredInEva: boolean
  endpoint: string
  message: string
}

export interface SearchProviderConnectivity {
  reachable: boolean
  apiValid: boolean
  endpoint: string
  resultCount: number
  unresponsiveEngines: string[]
  message: string
}

/** Plugins that implement the backend used by the web_search tool. */
export const SEARCH_PROVIDER_PLUGIN_IDS = [
  'brave-search',
  'tavily-search',
  'searxng-search',
  'duckduckgo-search',
  'bing-web-search',
  'bing-rss-search',
] as const
export type SearchProviderPluginId = (typeof SEARCH_PROVIDER_PLUGIN_IDS)[number]

/**
 * Search providers that read a public search engine directly: no API key, no
 * account quota, and no service to configure. Priority order matters because
 * every installed provider in this list backs up whichever provider is enabled.
 */
export const KEYLESS_SEARCH_PROVIDER_PLUGIN_IDS = ['duckduckgo-search', 'bing-web-search', 'bing-rss-search'] as const
export type KeylessSearchProviderPluginId = (typeof KEYLESS_SEARCH_PROVIDER_PLUGIN_IDS)[number]

export function isSearchProviderPluginId(id: string): id is SearchProviderPluginId {
  return (SEARCH_PROVIDER_PLUGIN_IDS as readonly string[]).includes(id)
}

export function isKeylessSearchProviderPluginId(id: string): id is KeylessSearchProviderPluginId {
  return (KEYLESS_SEARCH_PROVIDER_PLUGIN_IDS as readonly string[]).includes(id)
}

export const PLUGIN_CATEGORIES: Record<PluginCategory, string> = {
  integration: 'Integrations',
  automation: 'Automation',
  research: 'Research',
  'developer-tools': 'Developer tools',
}

export const PLUGIN_PERMISSIONS: Record<PluginPermission, string> = {
  'filesystem-read': 'Read files',
  'filesystem-write': 'Write files',
  terminal: 'Run commands',
  network: 'Internet access',
}
