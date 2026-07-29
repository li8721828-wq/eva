import Store from 'electron-store'
import { MARKETPLACE_PLUGINS, validatePluginManifest } from '../../shared/plugin-marketplace'
import type { InstalledPlugin, MarketplacePluginView, PluginManifest } from '../../shared/types/plugin'

const SEARCH_PLUGIN_IDS = new Set(['brave-search', 'tavily-search', 'searxng-search'])

interface PluginStoreSchema {
  plugins: InstalledPlugin[]
}

export class PluginStore {
  private readonly store = new Store<PluginStoreSchema>({ name: 'plugins', defaults: { plugins: [] } })

  list(): InstalledPlugin[] {
    return [...this.store.get('plugins')].sort((left, right) => left.name.localeCompare(right.name))
  }

  marketplace(): MarketplacePluginView[] {
    const installedById = new Map(this.store.get('plugins').map((plugin) => [plugin.id, plugin]))
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
    const nextSettings = Object.fromEntries(
      Object.entries(settings).filter(([key, value]) => allowedKeys.has(key) && ['string', 'number', 'boolean'].includes(typeof value))
    )
    const next = { ...plugins[index], settings: nextSettings, updatedAt: new Date().toISOString() }
    plugins[index] = next
    this.store.set('plugins', plugins)
    return next
  }

  get(id: string): InstalledPlugin | undefined {
    return this.store.get('plugins').find((plugin) => plugin.id === id)
  }

  setEnabled(id: string, enabled: boolean): InstalledPlugin {
    const plugins = this.store.get('plugins')
    const index = plugins.findIndex((plugin) => plugin.id === id)
    if (index < 0) throw new Error('Installed plugin was not found.')
    const next = { ...plugins[index], enabled, updatedAt: new Date().toISOString() }
    if (enabled && SEARCH_PLUGIN_IDS.has(id)) {
      for (let otherIndex = 0; otherIndex < plugins.length; otherIndex += 1) {
        if (otherIndex !== index && SEARCH_PLUGIN_IDS.has(plugins[otherIndex].id) && plugins[otherIndex].enabled) {
          plugins[otherIndex] = { ...plugins[otherIndex], enabled: false, updatedAt: next.updatedAt }
        }
      }
    }
    plugins[index] = next
    this.store.set('plugins', plugins)
    return next
  }

  remove(id: string): void {
    const plugins = this.store.get('plugins')
    if (!plugins.some((plugin) => plugin.id === id)) throw new Error('Installed plugin was not found.')
    this.store.set('plugins', plugins.filter((plugin) => plugin.id !== id))
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
    return next
  }
}
