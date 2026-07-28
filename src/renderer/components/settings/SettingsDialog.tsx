import React, { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/Dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Separator } from '@/components/ui/Separator'
import { APP_VERSION } from '../../../shared/constants'
import {
  AlertCircle,
  Bot,
  Box,
  CheckCircle2,
  Eye,
  EyeOff,
  FolderOpen,
  Info,
  Key,
  Link,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
} from 'lucide-react'
import type { ProviderConfigEntry, ProviderModelOption, ProviderTestConfig } from '../../../shared/types/provider'
import type { QqRemoteConfig, QqRemoteStatus } from '../../../shared/types/qq'
import type { Workspace } from '../../../shared/types/workspace'
import type { AgentConfig } from '../../../shared/types/agent'
import evaMark from '@/assets/eva-mark.svg'
import { PluginCenter } from './PluginCenter'

type ProviderType = ProviderConfigEntry['type']

const PROVIDER_OPTIONS: Array<{ value: ProviderType; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)' },
]

const EMPTY_QQ_CONFIG: QqRemoteConfig = {
  enabled: false,
  appId: '',
  hasAppSecret: false,
  allowedUserIds: [],
  defaultWorkspaceId: null,
  defaultAgentId: null,
  sandbox: false,
}

export function SettingsDialog() {
  const {
    settingsOpen,
    setSettingsOpen,
    workspacePath,
    setWorkspacePath,
    activeProviderId,
    setActiveProvider,
    activeModel,
    setActiveModel,
    setAgentManagerOpen,
  } = useAppStore()

  const [providerType, setProviderType] = useState<ProviderType>(activeProviderId as ProviderType)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [selectedModel, setSelectedModel] = useState(activeModel)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [availableModels, setAvailableModels] = useState<ProviderModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsMessage, setModelsMessage] = useState<string | null>(null)
  const [qqConfig, setQqConfig] = useState<QqRemoteConfig>(EMPTY_QQ_CONFIG)
  const [qqSecret, setQqSecret] = useState('')
  const [showQqSecret, setShowQqSecret] = useState(false)
  const [qqStatus, setQqStatus] = useState<QqRemoteStatus>({ state: 'disabled', message: 'QQ remote control is not configured.' })
  const [qqWorkspaces, setQqWorkspaces] = useState<Workspace[]>([])
  const [qqAgents, setQqAgents] = useState<AgentConfig[]>([])
  const [qqSaving, setQqSaving] = useState(false)
  const [qqResult, setQqResult] = useState<{ success: boolean; message: string } | null>(null)

  const getProviderTestConfig = (): ProviderTestConfig => ({
    id: providerType,
    name: PROVIDER_OPTIONS.find((provider) => provider.value === providerType)?.label || providerType,
    type: providerType,
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.trim() || undefined,
    defaultModel: selectedModel.trim(),
  })

  const validateProviderConfig = (): string | null => {
    const config = getProviderTestConfig()
    if (!config.apiKey) return 'Enter an API key before saving.'
    if (config.type === 'custom' && !config.baseUrl) return 'Enter a base URL for a custom provider.'
    if (!config.defaultModel) return 'Choose or enter a default model before saving.'
    return null
  }

  const invalidateModels = () => {
    setAvailableModels([])
    setModelsMessage(null)
    setSelectedModel('')
  }

  useEffect(() => {
    if (!settingsOpen) return
    setProviderType(activeProviderId as ProviderType)
    setSelectedModel(activeModel)
    setTestResult(null)
    setShowApiKey(false)
    setAvailableModels([])
    setModelsMessage(null)
  }, [settingsOpen])

  useEffect(() => {
    if (!settingsOpen) return
    const timer = window.setInterval(() => {
      void window.eva.qqRemote.getStatus().then(setQqStatus).catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [settingsOpen])

  useEffect(() => {
    if (!settingsOpen) return
    let cancelled = false

    const loadProviderConfig = async () => {
      try {
        const providers = (await window.eva.provider.list()) as ProviderConfigEntry[]
        const current = providers.find((provider) => provider.id === providerType)
        if (cancelled) return
        setApiKey(current?.apiKey || '')
        setBaseUrl(current?.baseUrl || '')
      } catch (error) {
        console.error('Failed to load provider config:', error)
      }
    }

    void loadProviderConfig()
    return () => {
      cancelled = true
    }
  }, [settingsOpen, providerType])

  useEffect(() => {
    if (!settingsOpen) return
    let cancelled = false
    const loadQqRemote = async () => {
      try {
        const [config, status, workspaces, agents] = await Promise.all([
          window.eva.qqRemote.getConfig(),
          window.eva.qqRemote.getStatus(),
          window.eva.workspace.list(),
          window.eva.agent.list(),
        ])
        if (cancelled) return
        setQqConfig(config)
        setQqStatus(status)
        setQqWorkspaces(workspaces)
        setQqAgents(agents)
        setQqSecret('')
        setQqResult(null)
      } catch {
        if (!cancelled) setQqResult({ success: false, message: 'Unable to load QQ remote-control settings.' })
      }
    }
    void loadQqRemote()
    return () => { cancelled = true }
  }, [settingsOpen])

  const handleBrowseFolder = async () => {
    try {
      const path = await window.eva.file.selectFolder()
      if (path) setWorkspacePath(path)
    } catch (error) {
      console.error('Failed to select folder:', error)
    }
  }

  const handleSaveProvider = async () => {
    const validationError = validateProviderConfig()
    if (validationError) {
      setTestResult({ success: false, message: validationError })
      return
    }

    setSaving(true)
    try {
      const configToSave = getProviderTestConfig()
      const config: ProviderConfigEntry = {
        id: configToSave.id,
        name: configToSave.name,
        type: configToSave.type,
        apiKey: configToSave.apiKey,
        baseUrl: configToSave.baseUrl,
        isEnabled: true,
      }

      await window.eva.config.set('activeProviderId', providerType)
      await window.eva.config.set('activeModel', selectedModel)
      await window.eva.provider.saveConfig(config)
      setActiveProvider(providerType)
      setActiveModel(selectedModel)
      setTestResult({
        success: true,
        message: 'Configuration saved and applied to built-in agents.',
      })
    } catch (error) {
      setTestResult({ success: false, message: 'Failed to save configuration.' })
    } finally {
      setSaving(false)
    }
  }

  const handleTestConnection = async () => {
    const validationError = validateProviderConfig()
    if (validationError) {
      setTestResult({ success: false, message: validationError })
      return
    }

    setTestResult(null)
    setTesting(true)
    try {
      setTestResult(await window.eva.provider.test(getProviderTestConfig()))
    } catch (error) {
      setTestResult({ success: false, message: 'Connection test failed.' })
    } finally {
      setTesting(false)
    }
  }

  const handleFetchModels = async () => {
    const config = getProviderTestConfig()
    if (!config.apiKey) {
      setModelsMessage('Enter an API key before fetching models.')
      return
    }
    if (config.type === 'custom' && !config.baseUrl) {
      setModelsMessage('Enter a base URL for a custom provider.')
      return
    }

    setLoadingModels(true)
    setModelsMessage(null)
    try {
      const result = await window.eva.provider.listModels(config)
      if (!result.success) {
        setAvailableModels([])
        setSelectedModel('')
        setModelsMessage(result.message || 'Failed to fetch models.')
        return
      }

      setAvailableModels(result.models)
      setSelectedModel((current) =>
        result.models.some((model) => model.id === current) ? current : result.models[0]?.id || ''
      )
    } catch (error) {
      setAvailableModels([])
      setSelectedModel('')
      setModelsMessage('Failed to fetch models.')
    } finally {
      setLoadingModels(false)
    }
  }

  const saveQqRemote = async (connect: boolean) => {
    const nextConfig = connect ? { ...qqConfig, enabled: true } : qqConfig
    if (nextConfig.enabled && !nextConfig.appId.trim()) {
      setQqResult({ success: false, message: 'Enter the QQ Bot AppID.' })
      return
    }
    if (nextConfig.enabled && !nextConfig.hasAppSecret && !qqSecret.trim()) {
      setQqResult({ success: false, message: 'Enter the QQ Bot AppSecret.' })
      return
    }
    if (nextConfig.enabled && nextConfig.allowedUserIds.length === 0) {
      setQqResult({ success: false, message: 'Add at least one allowed QQ OpenID.' })
      return
    }
    if (nextConfig.enabled && !nextConfig.defaultWorkspaceId) {
      setQqResult({ success: false, message: 'Choose the project workspace available to the remote agent.' })
      return
    }

    setQqSaving(true)
    setQqResult(null)
    try {
      const saved = await window.eva.qqRemote.saveConfig({
        ...nextConfig,
        appId: nextConfig.appId.trim(),
        appSecret: qqSecret.trim() || undefined,
      })
      setQqConfig(saved)
      setQqSecret('')
      if (connect && saved.enabled) {
        const status = await window.eva.qqRemote.connect()
        setQqStatus(status)
        setQqResult({ success: status.state === 'connected' || status.state === 'connecting', message: status.message })
      } else {
        setQqStatus(await window.eva.qqRemote.getStatus())
        setQqResult({ success: true, message: 'QQ remote-control settings saved.' })
      }
    } catch (error) {
      setQqResult({ success: false, message: error instanceof Error ? error.message : 'Failed to save QQ remote-control settings.' })
    } finally {
      setQqSaving(false)
    }
  }

  const disconnectQqRemote = async () => {
    setQqSaving(true)
    try {
      const status = await window.eva.qqRemote.disconnect()
      setQqStatus(status)
      setQqResult({ success: true, message: status.message })
    } finally {
      setQqSaving(false)
    }
  }

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen} className="settings-dialog">
      <DialogClose onClose={() => setSettingsOpen(false)} />
      <DialogHeader className="settings-dialog__header">
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription>Configure Eva to your preferences</DialogDescription>
      </DialogHeader>

      <Tabs defaultValue="general" className="settings-dialog__tabs">
        <TabsList className="settings-dialog__tabs-list">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="plugins">Plugins</TabsTrigger>
          <TabsTrigger value="qq">QQ Remote</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="settings-dialog__content">
          <div className="settings-dialog__general-layout">
            <div className="settings-dialog__card settings-dialog__field">
              <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-zinc-500" />
                Workspace Path
              </label>
              <div className="flex gap-2">
                <Input
                  value={workspacePath}
                  onChange={(event) => setWorkspacePath(event.target.value)}
                  placeholder="Select a folder or enter its full path"
                  className="flex-1"
                />
                <Button variant="outline" size="sm" onClick={handleBrowseFolder}>
                  Browse
                </Button>
              </div>
              <p className="text-xs leading-5 text-zinc-500">
                Used as a fallback for older conversations. New conversations use their selected project, and file access is configured in each conversation input bar.
              </p>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="models" className="settings-dialog__content">
          <div className="settings-dialog__model-layout">
            <div className="settings-dialog__card settings-dialog__model-card">
              <div className="settings-dialog__field">
                <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                  <Server className="h-4 w-4 text-zinc-500" />
                  Provider
                </label>
                <Select
                  value={providerType}
                  onChange={(event) => {
                    const nextProvider = event.target.value as ProviderType
                    setProviderType(nextProvider)
                    invalidateModels()
                    setTestResult(null)
                  }}
                  options={PROVIDER_OPTIONS}
                />
              </div>

              <Separator />

              <div className="settings-dialog__field">
                <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                  <Key className="h-4 w-4 text-zinc-500" />
                  API Key
                </label>
                <div className="relative">
                  <Input
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value)
                      invalidateModels()
                    }}
                    placeholder="sk-..."
                    className="pr-9"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((visible) => !visible)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 transition-colors hover:text-zinc-600"
                    aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                  >
                    {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              <Separator />

              <div className="settings-dialog__field">
                <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                  <Link className="h-4 w-4 text-zinc-500" />
                  Base URL
                  <span className="text-xs font-normal text-zinc-400">
                    {providerType === 'custom' ? '(required)' : '(optional)'}
                  </span>
                </label>
                <Input
                  value={baseUrl}
                  onChange={(event) => {
                    setBaseUrl(event.target.value)
                    invalidateModels()
                  }}
                  placeholder={providerType === 'custom' ? 'https://api.example.com/v1' : 'https://api.openai.com/v1'}
                />
              </div>

              <Separator />

              <div className="settings-dialog__field">
                <div className="settings-dialog__model-label-row">
                  <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                    <Box className="h-4 w-4 text-zinc-500" />
                    Default Model
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="settings-dialog__fetch-models"
                    onClick={handleFetchModels}
                    disabled={loadingModels || saving || testing}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${loadingModels ? 'animate-spin' : ''}`} />
                    {loadingModels ? 'Fetching...' : 'Fetch Models'}
                  </Button>
                </div>
                {availableModels.length > 0 ? (
                  <Select
                    value={selectedModel}
                    onChange={(event) => setSelectedModel(event.target.value)}
                    options={availableModels.map((model) => ({ value: model.id, label: model.name }))}
                  />
                ) : (
                  <div className="settings-dialog__models-empty">
                    {modelsMessage || 'Fetch models using the API key and base URL above.'}
                  </div>
                )}
              </div>
            </div>

            <div className="settings-dialog__actions">
              <Button variant="outline" onClick={handleTestConnection} disabled={testing || saving}>
                {testing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {testing ? 'Testing...' : 'Test Connection'}
              </Button>
              <Button onClick={handleSaveProvider} disabled={saving || testing} className="min-w-[80px]">
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>

            {testResult && (
              <div
                className="settings-dialog__result"
                data-status={testResult.success ? 'success' : 'error'}
              >
                {testResult.success ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 shrink-0" />
                )}
                {testResult.message}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="agents" className="settings-dialog__content">
          <div className="settings-dialog__card settings-dialog__agents-card">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm text-zinc-700">
                <Bot className="h-4 w-4" />
                Manage Agents
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSettingsOpen(false)
                  setAgentManagerOpen(true)
                }}
              >
                Manage
              </Button>
            </div>
            <Separator />
            <div className="py-4 text-center text-sm text-zinc-500">
              Open Agent Manager to create, edit, and remove custom agents.
            </div>
          </div>
        </TabsContent>

        <TabsContent value="plugins" className="settings-dialog__content">
          <PluginCenter />
        </TabsContent>

        <TabsContent value="qq" className="settings-dialog__content">
          <div className="settings-dialog__model-layout">
            <div className="settings-dialog__card settings-dialog__model-card">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                    <Smartphone className="h-4 w-4 text-violet-500" />
                    QQ remote control
                  </div>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">
                    Messages from approved QQ accounts are routed to an Eva conversation in the selected project.
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-sm text-zinc-600">
                  <input
                    type="checkbox"
                    checked={qqConfig.enabled}
                    onChange={(event) => setQqConfig((config) => ({ ...config, enabled: event.target.checked }))}
                    className="h-4 w-4 accent-violet-600"
                  />
                  Enabled
                </label>
              </div>

              <Separator />

              <div className="settings-dialog__field">
                <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                  <Key className="h-4 w-4 text-zinc-500" />
                  QQ Bot AppID
                </label>
                <Input value={qqConfig.appId} onChange={(event) => setQqConfig((config) => ({ ...config, appId: event.target.value }))} placeholder="QQ Open Platform AppID" autoComplete="off" />
              </div>

              <Separator />

              <div className="settings-dialog__field">
                <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                  <Key className="h-4 w-4 text-zinc-500" />
                  QQ Bot AppSecret
                  {qqConfig.hasAppSecret && <span className="text-xs font-normal text-emerald-600">Saved securely</span>}
                </label>
                <div className="relative">
                  <Input
                    type={showQqSecret ? 'text' : 'password'}
                    value={qqSecret}
                    onChange={(event) => setQqSecret(event.target.value)}
                    placeholder={qqConfig.hasAppSecret ? 'Leave blank to keep the saved secret' : 'Paste AppSecret'}
                    className="pr-9"
                    autoComplete="new-password"
                  />
                  <button type="button" onClick={() => setShowQqSecret((visible) => !visible)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-600" aria-label={showQqSecret ? 'Hide AppSecret' : 'Show AppSecret'}>
                    {showQqSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              <Separator />

              <div className="settings-dialog__field">
                <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-zinc-500" />
                  Allowed QQ OpenIDs (not QQ numbers)
                </label>
                <Input
                  value={qqConfig.allowedUserIds.join(', ')}
                  onChange={(event) => setQqConfig((config) => ({ ...config, allowedUserIds: event.target.value.split(/[\s,]+/).filter(Boolean) }))}
                  placeholder="QQ-assigned OpenIDs, separated by commas"
                />
                <p className="text-xs leading-5 text-zinc-500">QQ assigns a separate OpenID for each account; it is not the numeric QQ account. Send a test message, then copy the OpenID from the Activity Log&apos;s blocked request entry.</p>
              </div>

              <Separator />

              <div className="settings-dialog__field">
                <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-zinc-500" />
                  Default project workspace
                </label>
                <Select
                  value={qqConfig.defaultWorkspaceId || ''}
                  onChange={(event) => setQqConfig((config) => ({ ...config, defaultWorkspaceId: event.target.value || null }))}
                  options={[{ value: '', label: 'Select a project workspace' }, ...qqWorkspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))]}
                />
                <p className="text-xs leading-5 text-zinc-500">Remote conversations use workspace-only permissions. They never inherit full filesystem access.</p>
              </div>

              <Separator />

              <div className="settings-dialog__field">
                <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                  <Bot className="h-4 w-4 text-zinc-500" />
                  Default agent
                </label>
                <Select
                  value={qqConfig.defaultAgentId || ''}
                  onChange={(event) => setQqConfig((config) => ({ ...config, defaultAgentId: event.target.value || null }))}
                  options={[{ value: '', label: 'Use Eva default agent' }, ...qqAgents.map((agent) => ({ value: agent.id, label: agent.name }))]}
                />
              </div>

              <Separator />

              <div className="flex items-center justify-between gap-4 text-sm">
                <span className={qqStatus.state === 'connected' ? 'text-emerald-600' : qqStatus.state === 'error' ? 'text-red-600' : 'text-zinc-500'}>{qqStatus.message}</span>
                <label className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
                  <input type="checkbox" checked={qqConfig.sandbox} onChange={(event) => setQqConfig((config) => ({ ...config, sandbox: event.target.checked }))} className="h-3.5 w-3.5 accent-violet-600" />
                  QQ sandbox
                </label>
              </div>
            </div>

            <div className="settings-dialog__actions">
              {qqStatus.state === 'connected' || qqStatus.state === 'connecting' ? (
                <Button variant="outline" onClick={disconnectQqRemote} disabled={qqSaving}>Disconnect</Button>
              ) : null}
              <Button variant="outline" onClick={() => void saveQqRemote(false)} disabled={qqSaving}>Save</Button>
              <Button onClick={() => void saveQqRemote(true)} disabled={qqSaving} className="min-w-[116px]">
                {qqSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {qqSaving ? 'Working...' : 'Save & Connect'}
              </Button>
            </div>

            {qqResult && (
              <div className="settings-dialog__result" data-status={qqResult.success ? 'success' : 'error'}>
                {qqResult.success ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
                {qqResult.message}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="about" className="settings-dialog__content">
          <div className="settings-dialog__about">
            <div className="flex justify-center">
              <img src={evaMark} alt="Eva" className="h-12 w-12" />
            </div>
            <div>
              <h3 className="flex items-center justify-center gap-2 text-lg font-semibold text-zinc-900">
                <Info className="h-4 w-4" />
                Eva
              </h3>
              <p className="text-sm text-zinc-500">AI Coding Agent Desktop Client</p>
              <p className="mt-1 text-xs text-zinc-400">Version {APP_VERSION}</p>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </Dialog>
  )
}
