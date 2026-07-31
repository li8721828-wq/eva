import Store from 'electron-store'
import { MARKETPLACE_PLUGINS, validatePluginManifest } from '../../shared/plugin-marketplace'
import { isSearchProviderPluginId, type InstalledPlugin, type MarketplacePluginView, type PluginManifest } from '../../shared/types/plugin'
import { CredentialStore } from './credential-store'

interface PluginStoreSchema {
  plugins: InstalledPlugin[]
}

export class PluginStore {
  private readonly store = new Store<PluginStoreSchema>({ name: 'plugins', defaults: { plugins: [] } })
  private readonly credentials = new CredentialStore()

  constructor() {
    this.migratePluginCredentials()
  }

  list(): InstalledPlugin[] {
    return this.store.get('plugins')
      .map((plugin) => this.hydrateSecrets(plugin))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  marketplace(): MarketplacePluginView[] {
    const installedById = new Map(this.list().map((plugin) => [plugin.id, plugin]))
    return MARKETPLACE_PLUGINS.map((plugin) => ({ ...plugin, installedPlugin: installedById.get(plugin.id) }))
  }

  installMarketplace(id: string): InstalledPlugin {
    const plugin = MARKETPLACE_PLUGINS.find((entry) => entry.id === id)
    if (!plugin) throw new Error('Marketplace plugin was not found.')
    return this.upsert(plugin, 'marketplace')
  }

  importManifest(raw: unknown, sourcePath: string): InstalledPlugin {
    return this.upsert(validatePluginManifest(raw), 'local', sourcePath)
  }

  updateSettings(id: string, settings: Record<string, string | number | boolean>): InstalledPlugin {
    const plugins = this.store.get('plugins')
    const index = plugins.findIndex((plugin) => plugin.id === id)
    if (index < 0) throw new Error('Installed plugin was not found.')
    const allowedKeys = new Set(plugins[index].configuration?.map((field) => field.key) || [])
    const secretKeys = new Set(plugins[index].configuration?.filter((field) => field.type === 'secret').map((field) => field.key) || [])
    const nextSettings = Object.fromEntries(Object.entries(settings).filter(([key, value]) => {
      if (!allowedKeys.has(key) || !['string', 'number', 'boolean'].includes(typeof value)) return false
      if (secretKeys.has(key)) {
        if (typeof value === 'string' && value.trim()) this.credentials.set(this.pluginCredentialKey(id, key), value.trim())
        return false
      }
      return true
    }))
    const next = { ...plugins[index], settings: nextSettings, updatedAt: new Date().toISOString() }
    plugins[index] = next
    this.store.set('plugins', plugins)
    return this.hydrateSecrets(next)
  }

  get(id: string): InstalledPlugin | undefined {
    const plugin = this.store.get('plugins').find((entry) => entry.id === id)
    return plugin ? this.hydrateSecrets(plugin) : undefined
  }

  setEnabled(id: string, enabled: boolean): InstalledPlugin {
    const plugins = this.store.get('plugins')
    const index = plugins.findIndex((plugin) => plugin.id === id)
    if (index < 0) throw new Error('Installed plugin was not found.')
    const next = { ...plugins[index], enabled, updatedAt: new Date().toISOString() }
    if (enabled && isSearchProviderPluginId(id)) {
      for (let otherIndex = 0; otherIndex < plugins.length; otherIndex += 1) {
        if (otherIndex !== index && isSearchProviderPluginId(plugins[otherIndex].id) && plugins[otherIndex].enabled) {
          plugins[otherIndex] = { ...plugins[otherIndex], enabled: false, updatedAt: next.updatedAt }
        }
      }
    }
    plugins[index] = next
    this.store.set('plugins', plugins)
    return this.hydrateSecrets(next)
  }

  remove(id: string): void {
    const plugins = this.store.get('plugins')
    const plugin = plugins.find((entry) => entry.id === id)
    if (!plugin) throw new Error('Installed plugin was not found.')
    this.store.set('plugins', plugins.filter((plugin) => plugin.id !== id))
    for (const field of plugin.configuration || []) {
      if (field.type === 'secret') this.credentials.delete(this.pluginCredentialKey(id, field.key))
    }
  }

  private upsert(manifest: PluginManifest, source: InstalledPlugin['source'], sourcePath?: string): InstalledPlugin {
    const plugins = this.store.get('plugins')
    const now = new Date().toISOString()
    const index = plugins.findIndex((plugin) => plugin.id === manifest.id)
    const next: InstalledPlugin = {
      ...manifest,
      enabled: index >= 0 ? plugins[index].enabled : true,
      source,
      sourcePath,
      settings: index >= 0 ? plugins[index].settings : {},
      installedAt: index >= 0 ? plugins[index].installedAt : now,
      updatedAt: now,
    }

    if (index >= 0) plugins[index] = next
    else plugins.push(next)
    this.store.set('plugins', plugins)
    return this.hydrateSecrets(next)
  }

  private pluginCredentialKey(pluginId: string, settingKey: string): string {
    return `plugin:${pluginId}:${settingKey}`
  }

  private hydrateSecrets(plugin: InstalledPlugin): InstalledPlugin {
    const settings = { ...plugin.settings }
    for (const field of plugin.configuration || []) {
      if (field.type === 'secret') settings[field.key] = this.credentials.get(this.pluginCredentialKey(plugin.id, field.key))
    }
    return { ...plugin, settings }
  }

  private migratePluginCredentials(): void {
    const plugins = this.store.get('plugins')
    if (!this.credentials.isAvailable()) return
    let changed = false
    const migrated = plugins.map((plugin) => {
      const settings = { ...plugin.settings }
      for (const field of plugin.configuration || []) {
        if (field.type !== 'secret' || typeof settings[field.key] !== 'string' || !settings[field.key]) continue
        this.credentials.set(this.pluginCredentialKey(plugin.id, field.key), String(settings[field.key]))
        delete settings[field.key]
        changed = true
      }
      return changed ? { ...plugin, settings } : plugin
    })
    if (changed) this.store.set('plugins', migrated)
  }
}
