import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Download, Eye, EyeOff, FolderOpen, FolderUp, Loader2, PackageCheck, PlugZap, Power, RefreshCw, Server, Settings2, ShieldCheck, Square, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { cn } from '@/lib/utils'
import { isSearchProviderPluginId, PLUGIN_CATEGORIES, PLUGIN_PERMISSIONS, type InstalledPlugin, type LocalSearxngStatus, type MarketplacePluginView, type PluginConfigField, type SearchProviderConnectivity } from '../../../shared/types/plugin'

function PermissionPills({ plugin }: { plugin: Pick<InstalledPlugin, 'permissions'> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {plugin.permissions.map((permission) => (
        <span key={permission} className="rounded bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
          {PLUGIN_PERMISSIONS[permission]}
        </span>
      ))}
    </div>
  )
}

function hasRequiredSettings(plugin: InstalledPlugin): boolean {
  return !(plugin.configuration || []).some((field) => field.required && !String(plugin.settings[field.key] ?? '').trim())
}

export function PluginCenter() {
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [marketplace, setMarketplace] = useState<MarketplacePluginView[]>([])
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [configuringId, setConfiguringId] = useState<string | null>(null)
  const [configValues, setConfigValues] = useState<Record<string, string>>({})
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({})
  const [localSearxngStatus, setLocalSearxngStatus] = useState<LocalSearxngStatus | null>(null)
  const [localSearxngWorking, setLocalSearxngWorking] = useState(false)
  const [connectionTest, setConnectionTest] = useState<SearchProviderConnectivity | null>(null)
  const [connectionTesting, setConnectionTesting] = useState(false)

  const refresh = useCallback(async () => {
    const [nextInstalled, nextMarketplace] = await Promise.all([
      window.eva.plugins.list(),
      window.eva.plugins.marketplace(),
    ])
    setInstalled(nextInstalled)
    setMarketplace(nextMarketplace)
  }, [])

  useEffect(() => {
    void refresh().catch((error) => setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to load plugins.' })).finally(() => setLoading(false))
  }, [refresh])

  const importPlugin = async () => {
    setWorkingId('import')
    setNotice(null)
    setConnectionTest(null)
    try {
      const plugin = await window.eva.plugins.importManifest()
      if (!plugin) return
      await refresh()
      setNotice({ kind: 'success', message: `${plugin.name} was imported. Review its permissions before enabling it.` })
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to import plugin.' })
    } finally {
      setWorkingId(null)
    }
  }

  const installMarketplace = async (plugin: MarketplacePluginView) => {
    setWorkingId(plugin.id)
    setNotice(null)
    try {
      await window.eva.plugins.installMarketplace(plugin.id)
      await refresh()
      setNotice({ kind: 'success', message: `${plugin.name} was installed and enabled.` })
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to install plugin.' })
    } finally {
      setWorkingId(null)
    }
  }

  const togglePlugin = async (plugin: InstalledPlugin) => {
    setWorkingId(plugin.id)
    setNotice(null)
    try {
      await window.eva.plugins.setEnabled(plugin.id, !plugin.enabled)
      await refresh()
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to change plugin state.' })
    } finally {
      setWorkingId(null)
    }
  }

  const removePlugin = async (plugin: InstalledPlugin) => {
    setWorkingId(plugin.id)
    setNotice(null)
    try {
      await window.eva.plugins.remove(plugin.id)
      await refresh()
      setNotice({ kind: 'success', message: `${plugin.name} was removed from Eva.` })
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to remove plugin.' })
    } finally {
      setWorkingId(null)
    }
  }

  const openConfiguration = (plugin: InstalledPlugin) => {
    const initial = Object.fromEntries((plugin.configuration || []).map((field) => [field.key, String(plugin.settings[field.key] ?? '')]))
    setConfiguringId(plugin.id)
    setConfigValues(initial)
    setVisibleSecrets({})
    setNotice(null)
    if (plugin.id === 'searxng-search') {
      void window.eva.plugins.getLocalSearxngStatus()
        .then(setLocalSearxngStatus)
        .catch((error) => setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to inspect Local Search.' }))
    } else {
      setLocalSearxngStatus(null)
    }
  }

  const installLocalSearxng = async () => {
    setLocalSearxngWorking(true)
    setNotice(null)
    try {
      const status = await window.eva.plugins.installLocalSearxng()
      setLocalSearxngStatus(status)
      setConfigValues((values) => ({ ...values, endpoint: status.endpoint }))
      await refresh()
      setNotice({ kind: 'success', message: 'Eva Local Search is running and is now the active web-search service.' })
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to set up Local Search.' })
    } finally {
      setLocalSearxngWorking(false)
    }
  }

  const refreshLocalSearxng = async () => {
    setLocalSearxngWorking(true)
    try {
      setLocalSearxngStatus(await window.eva.plugins.getLocalSearxngStatus())
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to inspect Local Search.' })
    } finally {
      setLocalSearxngWorking(false)
    }
  }

  const stopLocalSearxng = async () => {
    setLocalSearxngWorking(true)
    try {
      setLocalSearxngStatus(await window.eva.plugins.stopLocalSearxng())
      setNotice({ kind: 'success', message: 'Eva Local Search was stopped. Its settings are retained.' })
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to stop Local Search.' })
    } finally {
      setLocalSearxngWorking(false)
    }
  }

  const testConnection = async () => {
    const endpoint = configValues.endpoint?.trim() || ''
    setConnectionTesting(true)
    setConnectionTest(null)
    try {
      const result = await window.eva.plugins.testConnection(endpoint)
      setConnectionTest(result)
    } catch (error) {
      setConnectionTest({ reachable: false, apiValid: false, endpoint, resultCount: 0, unresponsiveEngines: [], message: error instanceof Error ? error.message : 'Unable to test the endpoint.' })
    } finally {
      setConnectionTesting(false)
    }
  }

  const browseConfigurationPath = async (field: PluginConfigField) => {
    const selected = await window.eva.plugins.selectPath(field.type === 'path-directory' ? 'directory' : 'file')
    if (selected) setConfigValues((values) => ({ ...values, [field.key]: selected }))
  }

  const saveConfiguration = async (plugin: InstalledPlugin) => {
    const fields = plugin.configuration || []
    if (fields.some((field) => field.required && !configValues[field.key]?.trim())) {
      setNotice({ kind: 'error', message: 'Complete the required plugin settings before saving.' })
      return
    }
    const settings = Object.fromEntries(fields.map((field) => [field.key, field.type === 'number' ? Number(configValues[field.key] || 0) : configValues[field.key].trim()]))
    setWorkingId(plugin.id)
    try {
      await window.eva.plugins.updateSettings(plugin.id, settings)
      await refresh()
      setConfiguringId(null)
      setNotice({ kind: 'success', message: `${plugin.name} settings were saved.` })
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Unable to save plugin settings.' })
    } finally {
      setWorkingId(null)
    }
  }

  const installedCount = useMemo(() => installed.filter((plugin) => plugin.enabled).length, [installed])
  const searchProviders = useMemo(() => installed.filter((plugin) => isSearchProviderPluginId(plugin.id)), [installed])
  const activeSearchProvider = useMemo(() => searchProviders.find((plugin) => plugin.enabled) ?? null, [searchProviders])
  const searchServiceReady = Boolean(activeSearchProvider && hasRequiredSettings(activeSearchProvider))

  return (
    <div className="settings-dialog__plugin-layout">
      <div className="settings-dialog__plugin-intro">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600"><PlugZap className="h-5 w-5" /></span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Plugin center</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-500">Install integrations and reusable workflows. Search providers supply the backend used by the separate Web search Agent tool.</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void importPlugin()} disabled={workingId !== null} className="shrink-0 gap-1.5">
          {workingId === 'import' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderUp className="h-3.5 w-3.5" />}
          Import manifest
        </Button>
      </div>

      {notice && (
        <div className="settings-dialog__result" data-status={notice.kind}>
          {notice.kind === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <ShieldCheck className="h-4 w-4 shrink-0" />}
          {notice.message}
        </div>
      )}

      <section className="flex flex-wrap items-center justify-between gap-4 border-y border-zinc-200 py-4" aria-label="Web search service">
        <div>
          <p className="text-sm font-semibold text-zinc-900">Web search service</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">Agent permission is configured in Agents. Choose one provider here to decide where permitted web searches are sent.</p>
        </div>
        <div className={cn('eva-status', searchServiceReady ? 'eva-status--success' : activeSearchProvider ? 'eva-status--warning' : 'eva-status--neutral')}>
          {searchServiceReady
            ? `Active: ${activeSearchProvider?.name}`
            : activeSearchProvider
              ? `${activeSearchProvider.name} needs configuration`
              : 'No active search service'}
        </div>
      </section>

      <Tabs defaultValue="installed" className="settings-dialog__plugin-tabs">
        <TabsList className="settings-dialog__plugin-tabs-list">
          <TabsTrigger value="installed">Installed ({installed.length})</TabsTrigger>
          <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
        </TabsList>

        <TabsContent value="installed" className="settings-dialog__plugin-tab-content">
          {loading ? (
            <div className="settings-dialog__plugin-empty"><Loader2 className="h-4 w-4 animate-spin" /> Loading plugins...</div>
          ) : installed.length === 0 ? (
            <div className="settings-dialog__plugin-empty"><PackageCheck className="h-4 w-4" /> No plugins installed. Browse the marketplace or import an Eva plugin manifest.</div>
          ) : (
            <div className="settings-dialog__plugin-list">
              {installed.map((plugin) => (
                <article key={plugin.id} className="settings-dialog__plugin-card">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="truncate text-sm font-semibold text-zinc-900">{plugin.name}</h4>
                      {isSearchProviderPluginId(plugin.id) && <span className="rounded bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">Search provider</span>}
                      <span className={cn('eva-status px-2 py-0.5 text-[11px]', plugin.enabled ? 'eva-status--success' : 'eva-status--neutral')}>
                        {plugin.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-zinc-500">{plugin.description}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] text-zinc-500">
                      <span>{PLUGIN_CATEGORIES[plugin.category]}</span>
                      <span>v{plugin.version}</span>
                      <span>{plugin.source === 'marketplace' ? 'Marketplace' : 'Imported locally'}</span>
                    </div>
                    <div className="mt-3"><PermissionPills plugin={plugin} /></div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {plugin.configuration?.length ? (
                      <Button variant="ghost" size="icon" onClick={() => openConfiguration(plugin)} disabled={workingId !== null} title="Configure plugin" aria-label={`Configure ${plugin.name}`}>
                        <Settings2 className="h-4 w-4 text-zinc-500" />
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="icon" onClick={() => void togglePlugin(plugin)} disabled={workingId !== null} title={plugin.enabled ? 'Disable plugin' : 'Enable plugin'} aria-label={plugin.enabled ? `Disable ${plugin.name}` : `Enable ${plugin.name}`}>
                      {workingId === plugin.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className={cn('h-4 w-4', plugin.enabled ? 'text-emerald-600' : 'text-zinc-500')} />}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => void removePlugin(plugin)} disabled={workingId !== null} title="Remove plugin" aria-label={`Remove ${plugin.name}`}>
                      <Trash2 className="h-4 w-4 text-zinc-400 hover:text-red-600" />
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}

          {configuringId && (() => {
            const plugin = installed.find((item) => item.id === configuringId)
            if (!plugin) return null
            return (
              <section className="settings-dialog__plugin-config" aria-label={`${plugin.name} settings`}>
                <div className="flex items-start justify-between gap-4">
                  <div><h4 className="text-sm font-semibold text-zinc-900">Configure {plugin.name}</h4><p className="mt-1 text-xs leading-5 text-zinc-500">These values are stored locally and are available only to this connector.</p></div>
                  <Button variant="ghost" size="icon" onClick={() => setConfiguringId(null)} aria-label="Close plugin configuration"><X className="h-4 w-4" /></Button>
                </div>
                <div className="mt-5 grid gap-4">
                  {plugin.configuration?.map((field) => (
                    <label key={field.key} className="grid gap-2">
                      <span className="text-sm font-medium text-zinc-700">{field.label}{field.required ? <span className="ml-1 text-red-500">*</span> : null}</span>
                      {field.type === 'select' ? (
                        <select value={configValues[field.key] || ''} onChange={(event) => setConfigValues((values) => ({ ...values, [field.key]: event.target.value }))} className="h-9 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 shadow-sm focus:outline-none focus-visible:border-zinc-400">
                          <option value="">Select an option</option>
                          {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      ) : (
                        <div className="flex gap-2">
                          <div className="relative min-w-0 flex-1"><Input type={field.type === 'number' ? 'number' : field.type === 'secret' && !visibleSecrets[field.key] ? 'password' : 'text'} value={configValues[field.key] || ''} onChange={(event) => setConfigValues((values) => ({ ...values, [field.key]: event.target.value }))} placeholder={field.placeholder} className={field.type === 'secret' ? 'pr-9' : undefined} autoComplete={field.type === 'secret' ? 'off' : undefined} />{field.type === 'secret' ? <button type="button" onClick={() => setVisibleSecrets((current) => ({ ...current, [field.key]: !current[field.key] }))} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-600" aria-label={visibleSecrets[field.key] ? 'Hide API key' : 'Show API key'}>{visibleSecrets[field.key] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button> : null}</div>
                          {field.type === 'path-file' || field.type === 'path-directory' ? <Button type="button" variant="outline" size="sm" onClick={() => void browseConfigurationPath(field)} title="Browse path" aria-label={`Browse ${field.label}`}><FolderOpen className="h-4 w-4" /></Button> : null}
                        </div>
                      )}
                      {field.description ? <span className="text-xs leading-5 text-zinc-500">{field.description}</span> : null}
                    </label>
                  ))}
                </div>
                {plugin.id === 'searxng-search' ? (
                  <section className="mt-6 border-t border-zinc-200 pt-5" aria-label="Eva Local Search">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="flex min-w-0 gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600"><Server className="h-4 w-4" /></span>
                        <div>
                          <h5 className="text-sm font-semibold text-zinc-900">Eva Local Search</h5>
                          <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500">Set up a private SearXNG service on this computer. Eva downloads the official container image through Docker Desktop and keeps it bound to <code className="rounded bg-zinc-100 px-1 py-0.5 text-[11px] text-zinc-700">127.0.0.1:8080</code>.</p>
                        </div>
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => void refreshLocalSearxng()} disabled={localSearxngWorking} title="Refresh Local Search status" aria-label="Refresh Local Search status"><RefreshCw className={cn('h-4 w-4', localSearxngWorking && 'animate-spin')} /></Button>
                    </div>
                    <div className={cn('mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-xs', localSearxngStatus?.running ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-50 text-zinc-600')}>
                      <span>{localSearxngStatus?.message || 'Checking whether Local Search is available...'}</span>
                      {localSearxngStatus?.running ? <span className="font-medium">{localSearxngStatus.endpoint}</span> : null}
                    </div>
                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => void testConnection()} disabled={connectionTesting || !configValues.endpoint?.trim()}>
                        {connectionTesting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                        Test connection
                      </Button>
                      {localSearxngStatus?.running ? <Button variant="outline" size="sm" onClick={() => void stopLocalSearxng()} disabled={localSearxngWorking}><Square className="mr-1.5 h-3.5 w-3.5" />Stop service</Button> : null}
                      <Button size="sm" onClick={() => void installLocalSearxng()} disabled={localSearxngWorking || localSearxngStatus?.dockerAvailable === false}>
                        {localSearxngWorking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
                        {localSearxngStatus?.installed ? 'Start Local Search' : 'Install Local Search'}
                      </Button>
                    </div>
                    {connectionTest ? <div className={cn('mt-3 rounded-lg px-3 py-2.5 text-xs', connectionTest.apiValid && connectionTest.unresponsiveEngines.length === 0 ? 'bg-emerald-50 text-emerald-700' : connectionTest.reachable ? 'bg-amber-50 text-amber-800' : 'bg-red-50 text-red-700')} role="status">{connectionTest.message}</div> : null}
                    {localSearxngStatus?.dockerAvailable === false ? <p className="mt-3 text-xs leading-5 text-amber-700">Docker Desktop must be installed and running before Eva can install Local Search.</p> : null}
                  </section>
                ) : null}
                <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setConfiguringId(null)}>Cancel</Button><Button onClick={() => void saveConfiguration(plugin)} disabled={workingId !== null}>{workingId === plugin.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}Save settings</Button></div>
              </section>
            )
          })()}
          <p className="settings-dialog__plugin-note"><ShieldCheck className="h-3.5 w-3.5" /> Imported manifests are validated as data only. Eva never executes third-party Node code from an imported manifest.</p>
        </TabsContent>

        <TabsContent value="marketplace" className="settings-dialog__plugin-tab-content">
          <div className="settings-dialog__plugin-marketplace-note"><ShieldCheck className="h-4 w-4 text-violet-600" /> Curated entries are verified by Eva Labs. Search providers are alternatives: one enabled provider becomes the backend for the Web search Agent tool.</div>
          <div className="settings-dialog__plugin-marketplace-grid">
            {marketplace.map((plugin) => {
              const installedPlugin = plugin.installedPlugin
              return (
                <article key={plugin.id} className="settings-dialog__marketplace-card">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><h4 className="text-sm font-semibold text-zinc-900">{plugin.name}</h4>{plugin.verified && <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="Verified" />}</div>
                      <p className="mt-1 text-[11px] text-zinc-500">{PLUGIN_CATEGORIES[plugin.category]} · v{plugin.version}</p>
                    </div>
                    <Button size="sm" variant={installedPlugin ? 'outline' : 'default'} onClick={() => void installMarketplace(plugin)} disabled={workingId !== null} className="shrink-0 gap-1.5">
                      {workingId === plugin.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : installedPlugin ? <PackageCheck className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                      {installedPlugin ? 'Update' : 'Install'}
                    </Button>
                  </div>
                  <p className="mt-3 text-xs leading-5 text-zinc-600">{plugin.description}</p>
                  <div className="mt-4"><PermissionPills plugin={plugin} /></div>
                  {plugin.requirements && <p className="mt-3 border-t border-zinc-100 pt-3 text-[11px] leading-4 text-zinc-500">{plugin.requirements}</p>}
                </article>
              )
            })}
          </div>
        </TabsContent>
      </Tabs>

      <div className="text-xs text-zinc-500"><span className="font-medium text-zinc-700">{installedCount}</span> enabled plugin{installedCount === 1 ? '' : 's'}.</div>
    </div>
  )
}
