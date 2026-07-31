import React, { useEffect, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Separator } from '@/components/ui/Separator'
import { APP_VERSION } from '../../../shared/constants'
import {
  AlertCircle,
  ArrowLeft,
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
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react'
import type { ProviderConfigEntry, ProviderModelOption, ProviderTestConfig } from '../../../shared/types/provider'
import type { QqRemoteConfig, QqRemoteStatus } from '../../../shared/types/qq'
import type { Workspace } from '../../../shared/types/workspace'
import type { AgentConfig } from '../../../shared/types/agent'
import type { AutomationConfig, HiddenCapabilityId } from '../../../shared/types/automation'
import { DEFAULT_AUTOMATION_CONFIG } from '../../../shared/types/automation'
import evaMark from '@/assets/eva-mark.svg'
import { PluginCenter } from './PluginCenter'
import { AgentManagementWorkspace } from '@/components/agents/AgentManagementWorkspace'

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

const HIDDEN_CAPABILITIES: Array<{ id: HiddenCapabilityId; name: string; description: string; workflow: string; context: string; dependencies: string }> = [
  { id: 'team', name: 'Team orchestration', description: 'Delegates complex work to specialist agents for research, implementation, review, and testing.', workflow: 'Agent -> delegate_to_team -> leader plan -> specialist runners -> consolidated result', context: 'Team roster, each agent model candidates, tool permissions, workspace access, recent conversation.', dependencies: 'TeamOrchestrator, AgentRunner, configured agents and model connections.' },
  { id: 'task', name: 'Task execution', description: 'Runs one bounded implementation or investigation through an isolated internal worker.', workflow: 'Agent -> run_task -> worker uses current tools and permissions -> result returned to agent', context: 'Task objective, active agent, current workspace, conversation context, allowed tools and access level.', dependencies: 'AgentRunner, ToolRegistry, current model connection.' },
  { id: 'goal', name: 'Goal execution', description: 'Builds and adapts a multi-step plan while executing toward a measurable outcome.', workflow: 'Agent -> run_goal -> plan steps -> execute and evaluate -> summary', context: 'Goal, workspace, permissions, maximum steps, timeout, previous step results.', dependencies: 'GoalPlanner, AgentRunner, assigned tools.' },
  { id: 'plan', name: 'Execution planning', description: 'Creates a structured plan without performing work, useful before risky or broad changes.', workflow: 'Agent -> create_execution_plan -> structured steps -> agent continues with the plan', context: 'User objective, workspace context, available tools, current model.', dependencies: 'Planning prompt and the active model connection.' },
  { id: 'spec', name: 'Specification templates', description: 'Loads a reusable task template and expands it into a structured implementation brief.', workflow: 'Agent -> apply_spec_template -> template expansion -> agent follows generated brief', context: 'Template ID, provided parameters, active workspace and conversation.', dependencies: 'SpecService and built-in or imported templates.' },
]

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
  } = useAppStore()

  const [providerType, setProviderType] = useState<ProviderType>('openai')
  const [providerName, setProviderName] = useState('OpenAI')
  const [providerEnabled, setProviderEnabled] = useState(true)
  const [editingProviderId, setEditingProviderId] = useState('')
  const [providerPendingDeletionId, setProviderPendingDeletionId] = useState<string | null>(null)
  const [savedProviders, setSavedProviders] = useState<ProviderConfigEntry[]>([])
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(activeModel ? [activeModel] : [])
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [availableModels, setAvailableModels] = useState<ProviderModelOption[]>([])
  const [modelSearch, setModelSearch] = useState('')
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
  const [automation, setAutomation] = useState<AutomationConfig>(DEFAULT_AUTOMATION_CONFIG)

  const getProviderTestConfig = (): ProviderTestConfig => ({
    id: editingProviderId || `provider-${providerType}`,
    name: providerName.trim() || PROVIDER_OPTIONS.find((provider) => provider.value === providerType)?.label || providerType,
    type: providerType,
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.trim() || undefined,
    defaultModel: selectedModelIds[0] || '',
  })

  const validateProviderConfig = (): string | null => {
    const config = getProviderTestConfig()
    if (!config.name) return 'Enter a name for this saved connection.'
    if (!config.apiKey) return 'Enter an API key before saving.'
    if (config.type === 'custom' && !config.baseUrl) return 'Enter a base URL for a custom provider.'
    if (!config.defaultModel) return 'Select at least one model for this connection.'
    return null
  }

  const invalidateModels = () => {
    setAvailableModels([])
    setModelsMessage(null)
    setSelectedModelIds([])
    setModelSearch('')
  }

  const applyProviderProfile = (provider: ProviderConfigEntry) => {
    setEditingProviderId(provider.id)
    setProviderName(provider.name)
    setProviderType(provider.type)
    setProviderEnabled(provider.isEnabled)
    setApiKey(provider.apiKey)
    setBaseUrl(provider.baseUrl || '')
    const savedModels = provider.models?.length
      ? provider.models
      : provider.defaultModel
        ? [{ id: provider.defaultModel, name: provider.defaultModel }]
        : []
    setAvailableModels(savedModels)
    setSelectedModelIds(savedModels.map((model) => model.id))
    setModelSearch('')
    setModelsMessage(null)
    setTestResult(null)
  }

  const startNewProviderProfile = (type: ProviderType = 'openai') => {
    setEditingProviderId(`provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setProviderType(type)
    setProviderName('New connection')
    setProviderEnabled(true)
    setApiKey('')
    setBaseUrl('')
    setSelectedModelIds([])
    setAvailableModels([])
    setModelSearch('')
    setModelsMessage(null)
    setTestResult(null)
  }

  useEffect(() => {
    if (!settingsOpen) return
    let cancelled = false
    void window.eva.provider.list().then((providers) => {
      if (cancelled) return
      setSavedProviders(providers)
      const current = providers.find((provider) => provider.id === activeProviderId)
        || providers.find((provider) => provider.isEnabled && provider.apiKey)
        || providers[0]
      if (current) applyProviderProfile(current)
      else startNewProviderProfile()
      setShowApiKey(false)
    }).catch((error) => console.error('Failed to load saved provider profiles:', error))
    return () => { cancelled = true }
  }, [settingsOpen])


  useEffect(() => {
    if (!settingsOpen) return
    void window.eva.config.get<AutomationConfig>('automation')
      .then((config) => setAutomation({
        ...DEFAULT_AUTOMATION_CONFIG,
        ...config,
        team: { ...DEFAULT_AUTOMATION_CONFIG.team, ...config?.team },
        task: { ...DEFAULT_AUTOMATION_CONFIG.task, ...config?.task },
        goal: { ...DEFAULT_AUTOMATION_CONFIG.goal, ...config?.goal },
        plan: { ...DEFAULT_AUTOMATION_CONFIG.plan, ...config?.plan },
        spec: { ...DEFAULT_AUTOMATION_CONFIG.spec, ...config?.spec },
      }))
      .catch(() => setAutomation(DEFAULT_AUTOMATION_CONFIG))
  }, [settingsOpen])

  const updateAutomation = async (id: HiddenCapabilityId, updates: Partial<AutomationConfig[HiddenCapabilityId]>) => {
    const next = { ...automation, [id]: { ...automation[id], ...updates } } as AutomationConfig
    setAutomation(next)
    try {
      await window.eva.config.set('automation', next)
    } catch {
      setAutomation(automation)
    }
  }


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
        isEnabled: providerEnabled,
        defaultModel: configToSave.defaultModel,
        models: availableModels.filter((model) => selectedModelIds.includes(model.id)),
      }

      await window.eva.provider.saveConfig(config)
      setSavedProviders((providers) => {
        const index = providers.findIndex((provider) => provider.id === config.id)
        return index >= 0 ? providers.map((provider) => provider.id === config.id ? config : provider) : [...providers, config]
      })
      setEditingProviderId(config.id)
      setTestResult({
        success: true,
        message: providerEnabled
          ? 'Connection saved. Its models are now available in the chat model picker.'
          : 'Connection saved but hidden from the chat model picker until enabled.',
      })
    } catch (error) {
      setTestResult({ success: false, message: 'Failed to save configuration.' })
    } finally {
      setSaving(false)
    }
  }

  const toggleSavedProvider = async (provider: ProviderConfigEntry) => {
    const next = { ...provider, isEnabled: !provider.isEnabled }
    try {
      await window.eva.provider.saveConfig(next)
      setSavedProviders((providers) => providers.map((item) => item.id === next.id ? next : item))
      if (editingProviderId === next.id) setProviderEnabled(next.isEnabled)

      if (!next.isEnabled && provider.id === activeProviderId) {
        const fallback = savedProviders.find((item) => item.id !== provider.id && item.isEnabled && item.apiKey && item.defaultModel)
        if (fallback?.defaultModel) {
          await window.eva.config.set('activeProviderId', fallback.id)
          await window.eva.config.set('activeModel', fallback.defaultModel)
          setActiveProvider(fallback.id)
          setActiveModel(fallback.defaultModel)
        }
      }
    } catch (error) {
      setTestResult({ success: false, message: 'Failed to change this connection state.' })
    }
  }

  const deleteSavedProvider = async (provider: ProviderConfigEntry) => {
    try {
      await window.eva.provider.delete(provider.id)
      const remaining = savedProviders.filter((item) => item.id !== provider.id)
      setSavedProviders(remaining)
      setProviderPendingDeletionId(null)

      const fallback = remaining.find((item) => item.isEnabled && item.apiKey && (item.defaultModel || item.models?.[0]?.id))
      if (provider.id === activeProviderId) {
        const fallbackModel = fallback?.defaultModel || fallback?.models?.[0]?.id || ''
        await window.eva.config.set('activeProviderId', fallback?.id || '')
        await window.eva.config.set('activeModel', fallbackModel)
        setActiveProvider(fallback?.id || '')
        setActiveModel(fallbackModel)
      }

      if (provider.id === editingProviderId) {
        if (fallback) applyProviderProfile(fallback)
        else startNewProviderProfile()
      }
      setTestResult({ success: true, message: `Deleted connection "${provider.name}".` })
    } catch (error) {
      setTestResult({ success: false, message: 'Failed to delete this connection.' })
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
        setSelectedModelIds([])
        setModelSearch('')
        setModelsMessage(result.message || 'Failed to fetch models.')
        return
      }

      setAvailableModels(result.models)
      setSelectedModelIds((current) => current.filter((id) => result.models.some((model) => model.id === id)))
      setModelSearch('')
    } catch (error) {
      setAvailableModels([])
      setSelectedModelIds([])
      setModelsMessage('Failed to fetch models.')
    } finally {
      setLoadingModels(false)
    }
  }

  const toggleModelSelection = (modelId: string) => {
    setSelectedModelIds((current) =>
      current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId]
    )
  }

  const toggleAllModels = () => {
    setSelectedModelIds((current) =>
      current.length === availableModels.length
        ? []
        : availableModels.map((model) => model.id)
    )
  }

  const filteredModels = availableModels.filter((model) => {
    const query = modelSearch.trim().toLowerCase()
    return !query || model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query)
  })

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

  if (!settingsOpen) return null

  return (
    <section className="settings-page" aria-label="Settings">
      <header className="settings-page__header">
        <div>
          <h1 className="settings-page__title">Settings</h1>
          <p className="settings-page__description">Configure Eva to your preferences</p>
        </div>
        <Button variant="ghost" size="icon" className="settings-page__back" onClick={() => setSettingsOpen(false)} title="Back to workspace" aria-label="Back to workspace">
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </header>

      <Tabs defaultValue="general" className="settings-dialog__tabs">
        <TabsList className="settings-dialog__tabs-list">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="automation">Automation</TabsTrigger>
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
            <div className="settings-dialog__card settings-dialog__model-card settings-dialog__model-card--flat">
              <section className="settings-dialog__provider-library" aria-label="Saved model connections">
                <div className="settings-dialog__provider-library-header">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium text-zinc-800"><Server className="h-4 w-4 text-zinc-500" /> Model connections</div>
                    <p>Every connection is independent: name it, choose its provider and model, then keep its own API key and endpoint.</p>
                  </div>
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => startNewProviderProfile()}>
                    <Plus className="h-3.5 w-3.5" /> Add connection
                  </Button>
                </div>
                <div className="settings-dialog__provider-library-list">
                  {savedProviders.length === 0 ? (
                    <div className="settings-dialog__provider-library-empty">No saved connections yet. Add one to configure a model channel.</div>
                  ) : savedProviders.map((provider) => {
                    const models = provider.models?.length ? provider.models : provider.defaultModel ? [{ id: provider.defaultModel, name: provider.defaultModel }] : []
                    return (
                      <article key={provider.id} className={`settings-dialog__provider-library-item ${provider.id === editingProviderId ? 'is-selected' : ''}`}>
                        <button type="button" className="settings-dialog__provider-library-edit" onClick={() => applyProviderProfile(provider)}>
                          <span className="settings-dialog__provider-library-name">
                            <strong>{provider.name}</strong>
                            <small>{PROVIDER_OPTIONS.find((option) => option.value === provider.type)?.label || provider.type}{provider.id === activeProviderId ? ' · Active' : ''}</small>
                          </span>
                          <span className="settings-dialog__provider-library-models">
                            {models.slice(0, 3).map((model) => <span key={model.id}>{model.name}</span>)}
                            {models.length > 3 ? <span>+{models.length - 3}</span> : null}
                            {models.length === 0 ? <span>No models fetched</span> : null}
                          </span>
                        </button>
                        <div className="settings-dialog__provider-library-actions">
                          <label className="settings-dialog__provider-library-switch" title={provider.isEnabled ? 'Hide from chat model picker. Agents can still use this connection.' : 'Show in chat model picker. Agents can still use this connection.'}>
                            <input type="checkbox" checked={provider.isEnabled} onChange={() => void toggleSavedProvider(provider)} />
                            <span>{provider.isEnabled ? 'Show in chat' : 'Hidden from chat'}</span>
                          </label>
                          {providerPendingDeletionId === provider.id ? (
                            <div className="settings-dialog__provider-delete-confirm">
                              <button type="button" onClick={() => setProviderPendingDeletionId(null)} title="Cancel deletion" aria-label="Cancel deletion"><X className="h-3.5 w-3.5" /></button>
                              <button type="button" onClick={() => void deleteSavedProvider(provider)} title="Permanently delete connection" aria-label="Permanently delete connection"><Trash2 className="h-3.5 w-3.5" /></button>
                            </div>
                          ) : (
                            <button type="button" className="settings-dialog__provider-delete" onClick={() => setProviderPendingDeletionId(provider.id)} title="Delete connection" aria-label={`Delete ${provider.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>
              </section>

              <Separator />

              <div className="settings-dialog__provider-profile-row">
                <div className="settings-dialog__field flex-1">
                  <label className="text-sm font-medium text-zinc-700">Connection name</label>
                  <Input value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder="e.g. DeepSeek personal" />
                </div>
              </div>

              <Separator />

              <div className="settings-dialog__field">
                <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                  <Server className="h-4 w-4 text-zinc-500" />
                  Provider type
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
                    Models
                  </label>
                  <div className="settings-dialog__model-label-actions">
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
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={toggleAllModels}
                      disabled={availableModels.length === 0 || loadingModels}
                    >
                      {selectedModelIds.length === availableModels.length ? 'Clear all' : 'Select all'}
                    </Button>
                  </div>
                </div>
                {availableModels.length > 0 ? (
                  <div className="settings-dialog__model-picker">
                    <Input
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      placeholder="Search fetched models"
                      aria-label="Search fetched models"
                    />
                    <div className="settings-dialog__model-options" role="group" aria-label="Models to include in this connection">
                      {filteredModels.length > 0 ? filteredModels.map((model) => (
                        <label key={model.id} className="settings-dialog__model-option">
                          <input
                            type="checkbox"
                            checked={selectedModelIds.includes(model.id)}
                            onChange={() => toggleModelSelection(model.id)}
                          />
                          <span>{model.name}</span>
                        </label>
                      )) : (
                        <div className="settings-dialog__model-no-results">No matching models.</div>
                      )}
                    </div>
                    <p className="settings-dialog__model-selection-summary">
                      {selectedModelIds.length === 0
                        ? 'Select one or more models to add them to this connection.'
                        : `${selectedModelIds.length} model${selectedModelIds.length === 1 ? '' : 's'} will be added to this connection.`}
                    </p>
                  </div>
                ) : (
                  <div className="settings-dialog__models-empty">
                    {modelsMessage || 'Fetch models using the API key and base URL above, then select the models for this connection.'}
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

        <TabsContent value="automation" className="settings-dialog__content">
          <section className="mx-auto w-full max-w-5xl divide-y divide-zinc-200 border-y border-zinc-200">
            <div className="py-5">
              <h2 className="text-base font-semibold text-zinc-900">Internal capabilities</h2>
              <p className="mt-1 text-sm leading-6 text-zinc-500">Capabilities available to the agent as internal tools. They stay within the current conversation and are injected into system context only when enabled.</p>
            </div>
            {HIDDEN_CAPABILITIES.map((capability) => {
              const config = automation[capability.id]
              return (
                <article key={capability.id} className="grid gap-5 py-5 lg:grid-cols-[minmax(0,1fr)_260px]">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-zinc-900">{capability.name}</h3>
                    <p className="mt-1 text-sm leading-6 text-zinc-600">{capability.description}</p>
                    <dl className="mt-4 grid gap-3 text-xs leading-5 text-zinc-500">
                      <div><dt className="font-medium text-zinc-700">Flow</dt><dd>{capability.workflow}</dd></div>
                      <div><dt className="font-medium text-zinc-700">System context</dt><dd>{capability.context}</dd></div>
                      <div><dt className="font-medium text-zinc-700">Skills and services</dt><dd>{capability.dependencies}</dd></div>
                    </dl>
                  </div>
                  <div className="flex flex-col gap-3 self-start border-l border-zinc-200 pl-5 text-sm">
                    <label className="flex cursor-pointer items-center justify-between gap-3 text-zinc-700"><span>Enabled</span><input type="checkbox" checked={config.enabled} onChange={(event) => void updateAutomation(capability.id, { enabled: event.target.checked })} className="h-4 w-4 accent-violet-600" /></label>
                    <label className="flex cursor-pointer items-center justify-between gap-3 text-zinc-700"><span>Agent may invoke</span><input type="checkbox" checked={config.autoInvoke} disabled={!config.enabled} onChange={(event) => void updateAutomation(capability.id, { autoInvoke: event.target.checked })} className="h-4 w-4 accent-violet-600 disabled:opacity-40" /></label>
                    {capability.id === 'goal' && (
                      <>
                        <label className="space-y-1 text-xs text-zinc-500"><span>Maximum steps</span><Input type="number" min={2} max={30} value={automation.goal.maxSteps} onChange={(event) => void updateAutomation('goal', { maxSteps: Math.max(2, Math.min(30, Number(event.target.value) || 12)) })} /></label>
                        <label className="space-y-1 text-xs text-zinc-500"><span>Timeout (minutes)</span><Input type="number" min={1} max={120} value={automation.goal.timeoutMinutes} onChange={(event) => void updateAutomation('goal', { timeoutMinutes: Math.max(1, Math.min(120, Number(event.target.value) || 30)) })} /></label>
                      </>
                    )}
                  </div>
                </article>
              )
            })}
          </section>
        </TabsContent>

        <TabsContent value="agents" className="settings-dialog__content settings-dialog__content--agents">
          <AgentManagementWorkspace />
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
    </section>
  )
}
