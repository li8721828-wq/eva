export type PluginCategory = 'integration' | 'automation' | 'research' | 'developer-tools'

export type PluginPermission =
  | 'filesystem-read'
  | 'filesystem-write'
  | 'terminal'
  | 'network'
  | 'blender'

export type PluginSettingValue = string | number | boolean

export interface PluginConfigField {
  key: string
  label: string
  description?: string
  type: 'text' | 'path-file' | 'path-directory' | 'number' | 'select'
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
  blender: 'Blender control',
}
