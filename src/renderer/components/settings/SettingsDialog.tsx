import { settingsDetailText } from '@/lib/settings-detail-copy'
import { ExecutionEnginePanel } from './ExecutionEnginePanel'
import React, { useEffect, useState, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs'
import { Switch } from '@/components/ui/Switch'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogClose, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog'
import { getModelContextWindowOptions } from '../../../shared/constants'
import {
  AlertCircle,
  ArrowLeft,
  Box,
  CheckCircle2,
  Eye,
  EyeOff,
  FolderOpen,
  Key,
  Link,
  Loader2,
  Network,
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
import type { AutomationConfig, HiddenCapabilityId, ToolApprovalPolicy } from '../../../shared/types/automation'
import { DEFAULT_AUTOMATION_CONFIG } from '../../../shared/types/automation'
import type { NetworkConfig, NetworkTestResult } from '../../../shared/types/network'
import { DEFAULT_NETWORK_CONFIG } from '../../../shared/types/network'
import { inferModelCapabilities } from '../../../shared/model-capabilities'
import { PluginCenter } from './PluginCenter'
import { McpPanel } from './McpPanel'
import { SkillPanel } from './SkillPanel'
import { LongTermMemoryPanel } from './LongTermMemoryPanel'
import { AppServerPanel } from './AppServerPanel'
import { AgentManagementWorkspace } from '@/components/agents/AgentManagementWorkspace'
import { CostCenter } from '@/components/cost/CostCenter'
import { ModelPoolPanel } from './ModelPoolPanel'
import { RuntimeIntrospectionPanel } from './RuntimeIntrospectionPanel'
import { pushToast } from '@/stores/use-toast-store'
import { settingsPageCopy } from '@/lib/settings-page-copy'
import { shellCopy } from '@/lib/shell-copy'
import { useShallow } from 'zustand/react/shallow'
import { uiCopy } from '@/lib/ui-copy'
import { buildProviderProfile, computeModelStamp, providerValidationError } from '@/lib/provider-profile'

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
    language,
    setLanguage,
    theme,
    setTheme,
  } = useAppStore(useShallow(s => ({ settingsOpen: s.settingsOpen, setSettingsOpen: s.setSettingsOpen, workspacePath: s.workspacePath, setWorkspacePath: s.setWorkspacePath, activeProviderId: s.activeProviderId, setActiveProvider: s.setActiveProvider, activeModel: s.activeModel, setActiveModel: s.setActiveModel, language: s.language, setLanguage: s.setLanguage, theme: s.theme, setTheme: s.setTheme })))

  const t = (text: string) => settingsDetailText(language, text)
  const [activeTab, setActiveTab] = useState('general')
  const [extensionTab, setExtensionTab] = useState('skills')
  const settingsGroups = [
    { id: 'preferences', label: language === 'zh' ? '偏好与模型' : language === 'ja' ? '基本設定とモデル' : 'Preferences and models', tabs: ['general', 'models', 'agents', 'memory'] },
    { id: 'connections', label: language === 'zh' ? '扩展与连接' : language === 'ja' ? '拡張と接続' : 'Extensions and connections', tabs: ['plugins', 'qq', 'app-server'] },
    { id: 'diagnostics', label: language === 'zh' ? '用量与诊断' : language === 'ja' ? '使用量と診断' : 'Usage and diagnostics', tabs: ['cost', 'introspection'] },
  ]
  const settingsGroup = settingsGroups.find(group => group.tabs.includes(activeTab))!
  const lastGroupTabs = useRef<Record<string, string>>({ preferences: 'general', connections: 'plugins', diagnostics: 'cost' })
  const navigateSettings = (tab: string) => {
    const group = settingsGroups.find(group => group.tabs.includes(tab))!
    lastGroupTabs.current[group.id] = tab
    setActiveTab(tab)
  }

  const automationSavingRef = useRef(false)
  const [automationSaving, setAutomationSaving] = useState(false)
  const [automationLoading, setAutomationLoading] = useState(true)
  const [automationLoadError, setAutomationLoadError] = useState(false)
  const [automationLoadAttempt, setAutomationLoadAttempt] = useState(0)
  const [providerType, setProviderType] = useState<ProviderType>('openai')
  const [providerName, setProviderName] = useState('OpenAI')
  const [providerEnabled, setProviderEnabled] = useState(true)
  const [editingProviderId, setEditingProviderId] = useState('')
  const [providerEditorOpen, setProviderEditorOpen] = useState(false)
  const [providerPendingDeletionId, setProviderPendingDeletionId] = useState<string | null>(null)
  const [savedProviders, setSavedProviders] = useState<ProviderConfigEntry[]>([])
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [pricingGroup, setPricingGroup] = useState('')
  const [modelName, setModelName] = useState(activeModel || '')
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(activeModel ? [activeModel] : [])
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [availableModels, setAvailableModels] = useState<ProviderModelOption[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [probingModelId, setProbingModelId] = useState<string | null>(null)
  const [modelsMessage, setModelsMessage] = useState<string | null>(null)
  /** Digest of the credentials a successful fetch used. Null means the list's origin is unknown. */
  const [modelsStamp, setModelsStamp] = useState<string | null>(null)
  const [qqConfig, setQqConfig] = useState<QqRemoteConfig>(EMPTY_QQ_CONFIG)
  const [qqSecret, setQqSecret] = useState('')
  const [showQqSecret, setShowQqSecret] = useState(false)
  const [qqStatus, setQqStatus] = useState<QqRemoteStatus>({ state: 'disabled', message: 'QQ remote control is not configured.' })
  const [qqWorkspaces, setQqWorkspaces] = useState<Workspace[]>([])
  const [qqAgents, setQqAgents] = useState<AgentConfig[]>([])
  const [qqSaving, setQqSaving] = useState(false)
  const [qqResult, setQqResult] = useState<{ success: boolean; message: string } | null>(null)
  const [automation, setAutomation] = useState<AutomationConfig>(DEFAULT_AUTOMATION_CONFIG)
  const automationRef = useRef(automation)
  automationRef.current = automation
  const [networkConfig, setNetworkConfig] = useState<NetworkConfig>(DEFAULT_NETWORK_CONFIG)
  const [networkTestUrl, setNetworkTestUrl] = useState('https://www.gstatic.com/generate_204')
  const [networkResult, setNetworkResult] = useState<NetworkTestResult | null>(null)
  const [networkSaving, setNetworkSaving] = useState(false)
  const [networkTesting, setNetworkTesting] = useState(false)
  const pageCopy = settingsPageCopy[language]
  const copy = uiCopy[language].settings
  const automationCopy = uiCopy[language].automation

  // The approval policy is a single global setting, unlike the per-conversation
  // file permission level, so it has no home in the per-capability cards.
  const approvalNotes: Record<ToolApprovalPolicy, string> = {
    off: automationCopy.approval.noteOff,
    safe: automationCopy.approval.noteSafe,
    strict: automationCopy.approval.noteStrict,
    paranoid: automationCopy.approval.noteParanoid,
  }

  const getProviderTestConfig = (): ProviderTestConfig => ({
    id: editingProviderId || `provider-${providerType}`,
    name: providerName.trim() || PROVIDER_OPTIONS.find((provider) => provider.value === providerType)?.label || providerType,
    type: providerType,
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.trim() || undefined,
    defaultModel: modelName.trim() || selectedModelIds[0] || '',
  })

  const validateProviderConfig = (): string | null => {
    const config = getProviderTestConfig()
    return providerValidationError(config, true)
  }

  const validateProviderConnection = (): string | null => {
    const config = getProviderTestConfig()
    const error = providerValidationError(config, false)
    return error === 'Enter a name for this saved connection.' ? null : error
  }

  const invalidateModels = () => {
    setAvailableModels([])
    setModelsMessage(null)
    setSelectedModelIds([])
    setModelSearch('')
    setModelsStamp(null)
  }

  const currentModelStamp = computeModelStamp(getProviderTestConfig())
  const modelsAreStale = availableModels.length > 0 && modelsStamp !== null && modelsStamp !== currentModelStamp

  const applyProviderProfile = (provider: ProviderConfigEntry, openEditor = true) => {
    setEditingProviderId(provider.id)
    setProviderName(provider.name)
    setProviderType(provider.type)
    setProviderEnabled(provider.isEnabled)
    setApiKey(provider.apiKey)
    setBaseUrl(provider.baseUrl || '')
    setPricingGroup(provider.pricingGroup || '')
    const savedModels = provider.models?.length
      ? provider.models
      : provider.defaultModel
        ? [{ id: provider.defaultModel, name: provider.defaultModel }]
        : []
    setAvailableModels(savedModels)
    setModelName(provider.defaultModel || savedModels[0]?.id || '')
    setSelectedModelIds(savedModels.map((model) => model.id))
    setModelSearch('')
    setModelsMessage(null)
    setModelsStamp(null)
    setTestResult(null)
    if (openEditor) setProviderEditorOpen(true)
  }

  const startNewProviderProfile = (type: ProviderType = 'openai', openEditor = true) => {
    setEditingProviderId(`provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setProviderType(type)
    setProviderName('New connection')
    setProviderEnabled(true)
    setApiKey('')
    setBaseUrl('')
    setPricingGroup('')
    setModelName('')
    setSelectedModelIds([])
    setAvailableModels([])
    setModelSearch('')
    setModelsMessage(null)
    setModelsStamp(null)
    setTestResult(null)
    setProviderEditorOpen(openEditor)
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
      if (current) applyProviderProfile(current, false)
      else startNewProviderProfile('openai', false)
      setShowApiKey(false)
    }).catch((error) => console.error('Failed to load saved provider profiles:', error))
    return () => { cancelled = true }
  }, [settingsOpen])

  useEffect(() => {
    if (!settingsOpen) return
    let cancelled = false
    void window.eva.network.getConfig()
      .then((config) => {
        if (!cancelled) setNetworkConfig(config)
      })
      .catch(() => {
        if (!cancelled) setNetworkResult({
          success: false,
          url: networkTestUrl,
          message: 'Unable to load network settings.',
        })
      })
    return () => { cancelled = true }
  }, [settingsOpen])


  useEffect(() => {
    if (!settingsOpen) return
    let cancelled = false
    setAutomationLoading(true)
    setAutomationLoadError(false)
    void window.eva.config.get<AutomationConfig>('automation')
      .then((config) => { if (!cancelled) setAutomation({
        ...DEFAULT_AUTOMATION_CONFIG,
        ...config,
        team: { ...DEFAULT_AUTOMATION_CONFIG.team, ...config?.team },
        task: { ...DEFAULT_AUTOMATION_CONFIG.task, ...config?.task },
        goal: { ...DEFAULT_AUTOMATION_CONFIG.goal, ...config?.goal },
        plan: { ...DEFAULT_AUTOMATION_CONFIG.plan, ...config?.plan },
        spec: { ...DEFAULT_AUTOMATION_CONFIG.spec, ...config?.spec },
        toolApproval: { ...DEFAULT_AUTOMATION_CONFIG.toolApproval, ...config?.toolApproval },
        sandbox: { ...DEFAULT_AUTOMATION_CONFIG.sandbox, ...config?.sandbox },
      }) })
      .catch(() => { if (!cancelled) setAutomationLoadError(true) })
      .finally(() => { if (!cancelled) setAutomationLoading(false) })
    return () => { cancelled = true }
  }, [settingsOpen, automationLoadAttempt])

  const refreshSandboxStatus = async (level = automationRef.current.sandbox.level) => {
    try {
      await window.eva.sandbox.setLevel(level)
    } catch {
      const copy = shellCopy[language]
      pushToast({ kind: 'warning', title: copy.refreshFailed, durationMs: 0,
        actions: [{ label: copy.retry, onClick: () => { void refreshSandboxStatus() } }] })
    }
  }

  const updateAutomation = async <K extends HiddenCapabilityId | 'toolApproval' | 'sandbox'>(id: K, updates: Partial<AutomationConfig[K]>) => {
    if (automationSavingRef.current) return
    automationSavingRef.current = true
    setAutomationSaving(true)
    const previous = automationRef.current
    const next = { ...previous, [id]: { ...previous[id], ...updates } } as AutomationConfig
    try {
      await window.eva.config.set('automation', next)
      automationRef.current = next
      setAutomation(next)
      if (id === 'sandbox' && next.sandbox.level !== previous.sandbox.level) await refreshSandboxStatus(next.sandbox.level)
    } catch {
      const copy = shellCopy[language]
      pushToast({ kind: 'error', title: copy.saveFailed, description: copy.saveHint, durationMs: 0,
        actions: [{ label: copy.retry, onClick: () => { void updateAutomation(id, updates) } }] })
    } finally {
      automationSavingRef.current = false
      setAutomationSaving(false)
    }
  }

  const saveNetworkConfig = async () => {
    setNetworkSaving(true)
    setNetworkResult(null)
    try {
      const saved = await window.eva.network.saveConfig(networkConfig)
      setNetworkConfig(saved)
      setNetworkResult({
        success: true,
        url: networkTestUrl,
        message: saved.mode === 'system'
          ? 'System proxy settings are now active for Eva.'
          : saved.mode === 'direct'
            ? 'Eva is now using a direct network connection.'
            : 'Manual proxy settings are now active for Eva.',
      })
    } catch (error) {
      setNetworkResult({
        success: false,
        url: networkTestUrl,
        message: error instanceof Error ? error.message : 'Unable to apply network settings.',
      })
    } finally {
      setNetworkSaving(false)
    }
  }

  const testNetworkConfig = async () => {
    setNetworkTesting(true)
    setNetworkResult(null)
    try {
      setNetworkResult(await window.eva.network.testConnection(networkTestUrl))
    } catch (error) {
      setNetworkResult({
        success: false,
        url: networkTestUrl,
        message: error instanceof Error ? error.message : 'Network test failed.',
      })
    } finally {
      setNetworkTesting(false)
    }
  }


  useEffect(() => {
    if (!settingsOpen || activeTab !== 'qq') return
    let cancelled = false
    let inFlight = false
    const refresh = async () => {
      if (cancelled || inFlight || document.hidden) return
      inFlight = true
      try {
        const status = await window.eva.qqRemote.getStatus()
        if (!cancelled) setQqStatus(status)
      } catch { /* The QQ settings panel shows connection errors from its initial load. */ }
      finally { inFlight = false }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 2000)
    const onVisibility = () => { void refresh() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility) }
  }, [settingsOpen, activeTab])

  useEffect(() => {
    if (!settingsOpen || activeTab !== 'qq') return
    let cancelled = false
    const loadQqRemote = async () => {
      try {
        const [config, workspaces, agents] = await Promise.all([
          window.eva.qqRemote.getConfig(), window.eva.workspace.list(), window.eva.agent.list(),
        ])
        if (cancelled) return
        setQqConfig(config)
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
  }, [settingsOpen, activeTab])

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
      const config = buildProviderProfile({ ...configToSave, pricingGroup, isEnabled: providerEnabled, selectedModelIds, availableModels })

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
      setProviderEditorOpen(false)
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
          await window.eva.config.selectModel(fallback.id, fallback.defaultModel)
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
        await window.eva.config.selectModel(fallback?.id || '', fallbackModel)
        setActiveProvider(fallback?.id || '')
        setActiveModel(fallbackModel)
      }

      if (provider.id === editingProviderId) {
        if (fallback) applyProviderProfile(fallback, false)
        else startNewProviderProfile('openai', false)
      }
      setTestResult({ success: true, message: `Deleted connection "${provider.name}".` })
    } catch (error) {
      setTestResult({ success: false, message: 'Failed to delete this connection.' })
    }
  }

  const handleTestConnection = async () => {
    // A model can only be selected after this connection has returned its model list.
    const validationError = validateProviderConnection()
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
        // A failed refresh must not destroy the list, the ticks or the probe results the user already has.
        setModelsMessage(result.message || 'Failed to fetch models.')
        return
      }

      setAvailableModels(result.models)
      setSelectedModelIds((current) => current.filter((id) => result.models.some((model) => model.id === id)))
      setModelSearch('')
      setModelsStamp(computeModelStamp(config))
    } catch (error) {
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

  const handleProbeModel = async (modelId: string) => {
    const config = getProviderTestConfig()
    if (!config.apiKey || (config.type === 'custom' && !config.baseUrl)) {
      setModelsMessage('Enter an API key and base URL before probing a model.')
      return
    }
    setProbingModelId(modelId)
    setModelsMessage(null)
    try {
      const result = await window.eva.provider.probeCapabilities({ provider: config, model: modelId })
      setAvailableModels((current) => current.map((model) => model.id === modelId ? { ...model, capabilities: result.profile } : model))
      setModelsMessage(result.message)
    } catch (error) {
      setModelsMessage(error instanceof Error ? error.message : 'Capability detection failed.')
    } finally {
      setProbingModelId(null)
    }
  }

  const handleContextWindowChange = (modelId: string, value: string) => {
    const contextWindowTokens = Number(value)
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return
    setAvailableModels((current) => current.map((model) => {
      if (model.id !== modelId) return model
      const profile = model.capabilities || inferModelCapabilities(providerType, model.id)
      return {
        ...model,
        capabilities: {
          ...profile,
          contextWindowTokens,
          source: 'declared',
          checkedAt: Date.now(),
        },
      }
    }))
  }

  const filteredModels = availableModels.filter((model) => {
    const query = modelSearch.trim().toLowerCase()
    return !query || model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query)
  })

  const qqSetupIssues = [
    ...(!qqConfig.appId.trim() ? [{ field: 'qq-app-id', text: pageCopy.needAppId }] : []),
    ...(!qqConfig.hasAppSecret && !qqSecret.trim() ? [{ field: 'qq-app-secret', text: pageCopy.needSecret }] : []),
    ...(!qqConfig.allowedUserIds.length ? [{ field: 'qq-allowed-ids', text: pageCopy.needOpenId }] : []),
    ...(!qqWorkspaces.some(workspace => workspace.id === qqConfig.defaultWorkspaceId) ? [{ field: 'qq-workspace', text: pageCopy.needProject }] : []),
    ...(qqConfig.defaultAgentId && !qqAgents.some(agent => agent.id === qqConfig.defaultAgentId) ? [{ field: 'qq-agent', text: pageCopy.missingAgent }] : []),
  ]

  const saveQqRemote = async (connect: boolean) => {
    const nextConfig = connect ? { ...qqConfig, enabled: true } : qqConfig
    if (nextConfig.enabled && qqSetupIssues.length) {
      setQqResult({ success: false, message: qqSetupIssues[0].text })
      document.getElementById(qqSetupIssues[0].field)?.focus()
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
        setQqResult({ success: true, message: pageCopy.saved })
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
      <Tabs value={activeTab} onValueChange={navigateSettings} className="settings-dialog__tabs">
        <div className="settings-page__masthead-band">
          <div className="settings-page__masthead">
            <header className="settings-page__header">
              <div className="settings-help-trigger">
                <h1 className="settings-page__title">{copy.title}</h1>
                <p className="settings-page__description settings-help">{copy.description}</p>
              </div>
              <Button variant="ghost" size="icon" className="settings-page__back" onClick={() => setSettingsOpen(false)} title={shellCopy[language].backWorkspace} aria-label={shellCopy[language].backWorkspace}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </header>

            <nav className="settings-category-nav" aria-label={copy.title}>
              {settingsGroups.map(group => <button type="button" key={group.id} data-settings-group={group.id} aria-pressed={settingsGroup.id === group.id} onClick={() => navigateSettings(lastGroupTabs.current[group.id])}>{group.label}</button>)}
            </nav>
            <TabsList className="settings-dialog__tabs-list">
              {settingsGroup.tabs.map(tab => <TabsTrigger key={tab} value={tab}>{({ general: copy.general, models: copy.models, agents: copy.agents, memory: shellCopy[language].memory, plugins: copy.plugins, qq: copy.qq, 'app-server': 'App Server', cost: copy.cost, introspection: shellCopy[language].introspection } as Record<string, string>)[tab]}</TabsTrigger>)}
            </TabsList>
          </div>
        </div>

        <TabsContent value="general" className="settings-dialog__content">
          <div className="settings-dialog__general-layout settings-general-page">
            <header className="settings-section-heading">
              <h2 className="text-base font-semibold text-zinc-900">{copy.general}</h2>
              <p className="text-sm text-zinc-500">{pageCopy.generalHint}</p>
            </header>
            <ExecutionEnginePanel />
            <section className="settings-form-section" aria-labelledby="general-appearance-title">
              <h3 id="general-appearance-title" className="settings-form-section-title">
                <Eye className="h-4 w-4" />
                {pageCopy.appearance}
              </h3>
              <div className="settings-basics-grid">
                <div className="settings-dialog__field">
                  <label htmlFor="settings-language" className="settings-field-label">
                    {copy.language}
                  </label>
                  <Select
                    id="settings-language"
                    value={language}
                    onChange={(event) => setLanguage(event.target.value as typeof language)}
                    options={[
                      { value: 'zh', label: '简体中文' },
                      { value: 'en', label: 'English' },
                      { value: 'ja', label: '日本語' },
                    ]}
                  />
                  <p className="settings-field-hint">{copy.languageDescription}</p>
                </div>
                <div className="settings-dialog__field">
                  <span id="settings-theme-label" className="settings-field-label">
                    {shellCopy[language].theme}
                  </span>
                  <div className="settings-theme-options" role="group" aria-labelledby="settings-theme-label">
                    {(['light', 'dark', 'starlight'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        className="settings-theme-option"
                        aria-pressed={theme === option}
                        onClick={() => setTheme(option)}
                      >
                        <span className="settings-theme-swatch" data-theme-option={option} aria-hidden="true">
                          <span />
                        </span>
                        <span>{shellCopy[language][option]}</span>
                        {theme === option && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                  <p className="settings-field-hint">{shellCopy[language].themeHint}</p>
                </div>
              </div>
              <div className="settings-dialog__field">
                <label htmlFor="settings-workspace" className="settings-field-label">
                  {copy.workspace}
                </label>
                <div className="flex min-w-0 items-center gap-2">
                  <Input
                    id="settings-workspace"
                    value={workspacePath}
                    onChange={(event) => setWorkspacePath(event.target.value)}
                    placeholder={copy.workspacePlaceholder}
                    className="min-w-0 flex-1"
                  />
                  <Button variant="outline" onClick={handleBrowseFolder}>
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    {copy.browse}
                  </Button>
                </div>
                <p className="settings-field-hint">{pageCopy.folderHint}</p>
              </div>
            </section>

            <section
              className="settings-form-section settings-network-section"
              aria-labelledby="settings-network-title"
            >
              <header>
                <h3 id="settings-network-title" className="settings-form-section-title">
                  <Network className="h-4 w-4" />
                  {pageCopy.network}
                </h3>
                <p className="settings-field-hint mt-1">{pageCopy.networkHint}</p>
              </header>
              <div className="settings-basics-grid">
                <div className="settings-dialog__field">
                  <label htmlFor="network-mode" className="settings-field-label">
                    {pageCopy.networkMode}
                  </label>
                  <Select
                    id="network-mode"
                    value={networkConfig.mode}
                    onChange={(event) => {
                      const mode = event.target.value as NetworkConfig['mode']
                      setNetworkConfig((config) => ({ ...config, mode }))
                      setNetworkResult(null)
                    }}
                    options={[
                      { value: 'system', label: pageCopy.systemProxy },
                      { value: 'manual', label: pageCopy.manualProxy },
                      { value: 'direct', label: pageCopy.direct },
                    ]}
                  />
                  <p className="settings-field-hint">{pageCopy.proxyHint}</p>
                </div>
                <div className="settings-dialog__field">
                  <label htmlFor="network-test-url" className="settings-field-label">
                    {pageCopy.probeAddress}
                  </label>
                  <Input
                    id="network-test-url"
                    value={networkTestUrl}
                    onChange={(event) => setNetworkTestUrl(event.target.value)}
                    placeholder="https://www.gstatic.com/generate_204"
                    autoComplete="off"
                  />
                  <p className="settings-field-hint">{pageCopy.probeHint}</p>
                </div>
              </div>
              {networkConfig.mode === 'manual' && (
                <div className="settings-basics-grid">
                  <div className="settings-dialog__field">
                    <label htmlFor="network-proxy" className="settings-field-label">
                      {pageCopy.proxyAddress}
                    </label>
                    <Input
                      id="network-proxy"
                      value={networkConfig.proxyRules}
                      onChange={(event) => {
                        setNetworkConfig((config) => ({ ...config, proxyRules: event.target.value }))
                        setNetworkResult(null)
                      }}
                      placeholder="http://127.0.0.1:7890"
                      autoComplete="off"
                    />
                    <p className="settings-field-hint">http=127.0.0.1:7890;https=127.0.0.1:7890</p>
                  </div>
                  <div className="settings-dialog__field">
                    <label htmlFor="network-bypass" className="settings-field-label">
                      {pageCopy.bypass}
                    </label>
                    <Input
                      id="network-bypass"
                      value={networkConfig.proxyBypassRules}
                      onChange={(event) => {
                        setNetworkConfig((config) => ({ ...config, proxyBypassRules: event.target.value }))
                        setNetworkResult(null)
                      }}
                      placeholder="&lt;local&gt;;localhost;127.0.0.1"
                      autoComplete="off"
                    />
                    <p className="settings-field-hint">{pageCopy.bypassHint}</p>
                  </div>
                </div>
              )}
              <div className="settings-form-actions">
                <Button
                  variant="outline"
                  onClick={() => void testNetworkConfig()}
                  disabled={networkTesting || networkSaving}
                >
                  {networkTesting ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {networkTesting ? pageCopy.testing : pageCopy.testConnection}
                </Button>
                <Button onClick={() => void saveNetworkConfig()} disabled={networkSaving || networkTesting}>
                  {networkSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {networkSaving ? pageCopy.applying : pageCopy.applyNetwork}
                </Button>
              </div>
              {networkResult && (
                <div
                  className="settings-dialog__result"
                  data-status={networkResult.success ? 'success' : 'error'}
                  role="status"
                >
                  {networkResult.success ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                  ) : (
                    <AlertCircle className="h-4 w-4 shrink-0" />
                  )}
                  <span className="min-w-0">
                    <span className="block">{networkResult.message}</span>
                    {networkResult.resolvedProxy && (
                      <span className="mt-0.5 block break-all text-xs opacity-80">
                        {networkResult.resolvedProxy}
                      </span>
                    )}
                  </span>
                </div>
              )}
            </section>
          </div>
        </TabsContent>

        <TabsContent value="models" className="settings-dialog__content">
          <div className="settings-dialog__model-layout">
            <div className="settings-model-sections settings-dialog__model-card">
              <section className="settings-dialog__provider-library" aria-label="Saved model connections">
                <div className="settings-dialog__provider-library-header">
                  <div>
                    <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900"><Server className="h-4 w-4 text-zinc-500" />{pageCopy.connections}</h2>
                    <p>{pageCopy.connectionsHint}</p>
                  </div>
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => startNewProviderProfile()}>
                    <Plus className="h-3.5 w-3.5" /> {pageCopy.addConnection}
                  </Button>
                </div>
                <div className="settings-dialog__provider-library-list">
                  {savedProviders.length === 0 ? (
                    <div className="settings-dialog__provider-library-empty">{pageCopy.noConnections}</div>
                  ) : savedProviders.map((provider) => {
                    const models = provider.models?.length ? provider.models : provider.defaultModel ? [{ id: provider.defaultModel, name: provider.defaultModel }] : []
                    return (
                      <article key={provider.id} className={`settings-dialog__provider-library-item ${provider.id === editingProviderId ? 'is-selected' : ''} ${provider.id === activeProviderId ? 'is-active' : ''}`}>
                        <button type="button" className="settings-dialog__provider-library-edit" onClick={() => applyProviderProfile(provider)}>
                          <span className="settings-dialog__provider-library-name">
                            <strong>{provider.name}</strong>{provider.id === activeProviderId && <span className="settings-provider-current">{pageCopy.active}</span>}
                            <small>{PROVIDER_OPTIONS.find((option) => option.value === provider.type)?.label || provider.type}</small>
                          </span>
                          <span className="settings-dialog__provider-library-models">
                            {models.slice(0, 3).map((model) => <span key={model.id}>{model.name}</span>)}
                            {models.length > 3 ? <span>+{models.length - 3}</span> : null}
                            {models.length === 0 ? <span>{pageCopy.noModels}</span> : null}
                          </span>
                        </button>
                        <div className="settings-dialog__provider-library-actions">
                          <label className="settings-dialog__provider-library-switch" title={provider.isEnabled ? pageCopy.hideHint : pageCopy.showHint}>
                            <Switch checked={provider.isEnabled} onChange={() => void toggleSavedProvider(provider)} />
                            <span>{pageCopy.visible}</span>
                          </label>
                          {providerPendingDeletionId === provider.id ? (
                            <div className="settings-dialog__provider-delete-confirm">
                              <button type="button" onClick={() => setProviderPendingDeletionId(null)} title={pageCopy.cancelDelete} aria-label={pageCopy.cancelDelete}><X className="h-3.5 w-3.5" /></button>
                              <button type="button" onClick={() => void deleteSavedProvider(provider)} title={pageCopy.confirmDelete} aria-label={pageCopy.confirmDelete}><Trash2 className="h-3.5 w-3.5" /></button>
                            </div>
                          ) : (
                            <button type="button" className="settings-dialog__provider-delete" onClick={() => setProviderPendingDeletionId(provider.id)} title={pageCopy.deleteConnection} aria-label={`${pageCopy.deleteConnection} ${provider.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
                          )}
                        </div>
                      </article>
                    )
                  })}
                </div>
              </section>

              <ModelPoolPanel providers={savedProviders} />

              {providerEditorOpen && <Dialog open={providerEditorOpen} onOpenChange={setProviderEditorOpen} className="settings-dialog__provider-editor">
                <DialogClose onClose={() => setProviderEditorOpen(false)} />
                <DialogHeader>
                  <DialogTitle>{providerName === 'New connection' ? t("Add model connection") : language === 'zh' ? `编辑 ${providerName}` : language === 'ja' ? `${providerName} を編集` : `Edit ${providerName}`}</DialogTitle>
                  <DialogDescription>{t("Configure this connection. Fetching models is optional when the gateway does not expose a model list.")}</DialogDescription>
                </DialogHeader>

                <div className="settings-dialog__provider-editor-form">
                  <div className="settings-dialog__field-row">
                    <div className="settings-dialog__field">
                      <label className="text-sm font-medium text-zinc-700">{t("Connection name")}</label>
                      <Input value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder={t("e.g. DeepSeek personal")} />
                    </div>
                    <div className="settings-dialog__field">
                      <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                        <Server className="h-4 w-4 text-zinc-500" />
                        {t("Provider type")}
                      </label>
                      <Select
                        value={providerType}
                        onChange={(event) => {
                          const nextProvider = event.target.value as ProviderType
                          setProviderType(nextProvider)
                          invalidateModels()
                          setModelName('')
                          setTestResult(null)
                        }}
                        options={PROVIDER_OPTIONS}
                      />
                    </div>
                  </div>

                  <div className="settings-dialog__field-row">
                    <div className="settings-dialog__field">
                      <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                        <Key className="h-4 w-4 text-zinc-500" />
                        API Key
                      </label>
                      <div className="relative">
                        <Input
                          type={showApiKey ? 'text' : 'password'}
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                          placeholder="sk-..."
                          className="pr-9"
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey((visible) => !visible)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 transition-colors hover:text-zinc-600"
                          aria-label={showApiKey ? t("Hide API key") : t("Show API key")}
                        >
                          {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                    <div className="settings-dialog__field">
                      <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                        <Link className="h-4 w-4 text-zinc-500" />
                        Base URL
                        <span className="text-xs font-normal text-zinc-400">
                          {providerType === 'custom' ? t("(required)") : t("(optional)")}
                        </span>
                      </label>
                      <Input
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        placeholder={providerType === 'custom' ? 'https://api.example.com/v1' : 'https://api.openai.com/v1'}
                      />
                    </div>
                  </div>

                <div className="settings-dialog__field">
                  <label className="text-sm font-medium text-zinc-700">{t("Supplier pricing group")} <span className="text-xs font-normal text-zinc-400">{t("(optional)")}</span></label>
                  <Input value={pricingGroup} onChange={(event) => setPricingGroup(event.target.value)} placeholder={t("e.g. default, group name from the supplier")} />
                  <p className="text-xs text-zinc-400">{t("Used only when this supplier routes the same model through different price groups. The Cost center never guesses a group.")}</p>
                </div>

                <div className="settings-dialog__field settings-dialog__field--models">
                <div className="settings-dialog__model-label-row">
                  <label className="text-sm font-medium text-zinc-700 flex items-center gap-2">
                    <Box className="h-4 w-4 text-zinc-500" />
                    {t("Models")}
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
                      {loadingModels ? t("Fetching...") : t("Fetch Models")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={toggleAllModels}
                      disabled={availableModels.length === 0 || loadingModels}
                    >
                      {selectedModelIds.length === availableModels.length ? t("Clear all") : t("Select all")}
                    </Button>
                  </div>
                </div>
                <div className="settings-dialog__field">
                  <label className="text-sm font-medium text-zinc-700">{t("Model name")} <span className="text-xs font-normal text-zinc-400">{t("(required)")}</span></label>
                  <Input
                    value={modelName}
                    onChange={(event) => setModelName(event.target.value)}
                    placeholder={t("e.g. gpt-4o-mini or provider-specific-model")}
                    aria-label={t("Model name")}
                  />
                  <p className="text-xs text-zinc-400">{t("Enter the exact model ID. Fetch Models is optional for gateways without a model-list endpoint.")}</p>
                </div>
                {availableModels.length > 0 ? (
                  <div className="settings-dialog__model-picker">
                    {(modelsMessage || modelsAreStale) && (
                      <div className="settings-dialog__models-notice" role="status">
                        {modelsMessage && <span>{modelsMessage}</span>}
                        {modelsAreStale && <span>{t("Credentials changed since this list was fetched. Fetch Models again to match the current key and base URL.")}</span>}
                      </div>
                    )}
                    <Input
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      placeholder={t("Search fetched models")}
                      aria-label={t("Search fetched models")}
                    />
                    <div className="settings-dialog__model-options" role="group" aria-label={t("Models to include in this connection")}>
                      {filteredModels.length > 0 ? filteredModels.map((model) => (
                        <label key={model.id} className="settings-dialog__model-option">
                          <input
                            type="checkbox"
                            checked={selectedModelIds.includes(model.id)}
                            onChange={() => toggleModelSelection(model.id)}
                          />
                          <span className="truncate">{model.name}</span>
                          <span className="settings-dialog__model-meta">
                            {model.capabilities && <span className={`settings-dialog__model-capability ${model.capabilities.supportsTools === false ? 'is-error' : model.capabilities.probeStatus === 'supported' ? 'is-success' : ''}`}>{model.capabilities.probeStatus === 'supported' ? '工具已验证' : model.capabilities.supportsTools === false ? '不支持工具' : '未探测'}</span>}
                            <select
                              className="settings-dialog__model-context"
                              aria-label={`Context window for ${model.name || model.id}`}
                              value={model.capabilities?.contextWindowTokens || inferModelCapabilities(providerType, model.id).contextWindowTokens}
                              onChange={(event) => handleContextWindowChange(model.id, event.target.value)}
                            >
                              {getModelContextWindowOptions(model.id, model.capabilities?.contextWindowTokens).map((tokens) => (
                                <option key={tokens} value={tokens}>{tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}K`}</option>
                              ))}
                            </select>
                            <button type="button" className="settings-dialog__model-probe" onClick={(event) => { event.preventDefault(); void handleProbeModel(model.id) }} disabled={probingModelId === model.id || loadingModels || saving || testing}>{probingModelId === model.id ? '探测中…' : '探测能力'}</button>
                          </span>
                        </label>
                      )) : (
                        <div className="settings-dialog__model-no-results">{t("No matching models.")}</div>
                      )}
                    </div>
                    <p className="settings-dialog__model-selection-summary">
                      {selectedModelIds.length === 0
                        ? t("Select one or more models to add them to this connection.")
                        : language === 'zh' ? `已选择 ${selectedModelIds.length} 个模型` : language === 'ja' ? `${selectedModelIds.length} モデルを選択` : `${selectedModelIds.length} model${selectedModelIds.length === 1 ? '' : 's'} will be added to this connection.`}
                    </p>
                  </div>
                ) : (
                  <div className="settings-dialog__models-empty">
                    {modelsMessage || t("No fetched models. The model name above will be saved as the connection model.")}
                  </div>
                )}
                </div>
              </div>

            <div className="settings-dialog__actions">
              <Button variant="outline" onClick={handleTestConnection} disabled={testing || saving}>
                {testing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {testing ? t("Testing...") : t("Test Connection")}
              </Button>
              <Button onClick={handleSaveProvider} disabled={saving || testing} className="min-w-[80px]">
                {saving ? t("Saving...") : t("Save")}
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
              </Dialog>}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="cost" className="settings-dialog__content">
          <CostCenter embedded />
        </TabsContent>

        <TabsContent value="introspection" className="settings-dialog__content">
          <RuntimeIntrospectionPanel />
        </TabsContent>


        <TabsContent value="plugins" className="settings-dialog__content">
          <header className="settings-section-heading"><h2 className="text-base font-semibold text-zinc-900">{copy.plugins}</h2><p className="text-sm text-zinc-500">{language === 'zh' ? '管理可复用的技能、插件与外部工具连接。' : language === 'ja' ? 'スキル、プラグイン、外部ツール接続を管理します。' : 'Manage reusable skills, plugins, and external tool connections.'}</p></header>
          <nav className="settings-extension-tabs" aria-label={copy.plugins}>{['skills', 'plugins', 'mcp'].map(tab => <button type="button" key={tab} aria-pressed={extensionTab === tab} onClick={() => setExtensionTab(tab)}>{tab === 'mcp' ? 'MCP' : tab === 'skills' ? uiCopy[language].skills.title : language === 'zh' ? '插件' : language === 'ja' ? 'プラグイン' : 'Plugins'}</button>)}</nav>
          <div className="settings-service-sections"><section>{extensionTab === 'skills' ? <SkillPanel /> : extensionTab === 'plugins' ? <PluginCenter /> : <McpPanel />}</section></div>

          {automationLoadError && <div role="alert" className="mb-4 flex items-center gap-3 text-sm text-red-600"><span>{shellCopy[language].loadFailed}</span><Button variant="outline" onClick={() => setAutomationLoadAttempt(n => n + 1)}>{shellCopy[language].retry}</Button></div>}
          <fieldset disabled={automationSaving || automationLoading || automationLoadError} aria-busy={automationSaving || automationLoading} className="mx-auto min-w-0 w-full max-w-6xl">
            <div className="mb-6">
              <h2 className="text-base font-semibold text-zinc-900">{language === 'zh' ? '任务自动化与执行权限' : language === 'ja' ? 'タスク自動化と実行権限' : 'Task automation and execution permissions'}</h2>
              <p className="mt-1 text-sm leading-6 text-zinc-500">{automationCopy.description}</p>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {HIDDEN_CAPABILITIES.map((capability) => {
                const config = automation[capability.id]
                return (
                  <article key={capability.id} className="eva-panel flex flex-col gap-4 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-zinc-900">{language === 'zh' ? ({ team: '团队协作', task: '独立任务', goal: '多步任务', plan: '执行规划', spec: '任务模板' } as Record<string, string>)[capability.id] : capability.name}</h3>
                        <p className="mt-1 text-sm leading-6 text-zinc-600">{language === 'zh' ? ({ team: '把需要不同专长的工作交给多个智能体协作。', task: '在独立工作会话中处理范围明确的任务。', goal: '分步推进目标，并根据执行结果调整计划。', plan: '生成执行计划，规划阶段不修改项目。', spec: '使用可复用模板整理任务要求。' } as Record<string, string>)[capability.id] : capability.description}</p>
                      </div>
                      <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-zinc-600">
                        <span>{config.enabled ? automationCopy.enabled : automationCopy.off}</span>
                        <Switch checked={config.enabled} onChange={(event) => void updateAutomation(capability.id, { enabled: event.target.checked })} />
                      </label>
                    </div>
                    <details className="settings-technical-details"><summary>{language === 'zh' ? '运行细节' : language === 'ja' ? '実行の詳細' : 'Execution details'}</summary><dl className="mt-3 grid gap-3 text-xs leading-5 text-zinc-500">
                      <div><dt className="font-medium text-zinc-700">{automationCopy.flow}</dt><dd className="mt-0.5">{capability.workflow}</dd></div>
                      <div><dt className="font-medium text-zinc-700">{automationCopy.context}</dt><dd className="mt-0.5 line-clamp-2">{capability.context}</dd></div>
                      <div><dt className="font-medium text-zinc-700">{automationCopy.services}</dt><dd className="mt-0.5 line-clamp-2">{capability.dependencies}</dd></div>
                    </dl></details>
                    <div className="border-t border-[var(--ui-border)] pt-3">
                      <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-zinc-700"><span>{automationCopy.invoke}</span><Switch checked={config.autoInvoke} disabled={!config.enabled} onChange={(event) => void updateAutomation(capability.id, { autoInvoke: event.target.checked })} /></label>
                      {capability.id === 'goal' && (
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <label className="space-y-1 text-xs text-zinc-500"><span>{automationCopy.maxSteps}</span><Input type="number" min={2} max={30} value={automation.goal.maxSteps} onChange={(event) => void updateAutomation('goal', { maxSteps: Math.max(2, Math.min(30, Number(event.target.value) || 12)) })} /></label>
                          <label className="space-y-1 text-xs text-zinc-500"><span>{automationCopy.timeout}</span><Input type="number" min={1} max={120} value={automation.goal.timeoutMinutes} onChange={(event) => void updateAutomation('goal', { timeoutMinutes: Math.max(1, Math.min(120, Number(event.target.value) || 30)) })} /></label>
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>

            {/* Tool approval */}
            <section className="eva-lift eva-panel mt-6 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-zinc-900">{automationCopy.approval.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-zinc-600">{automationCopy.approval.description}</p>
                </div>
                <select
                  className="shrink-0 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  value={automation.toolApproval.policy}
                  onChange={(event) => {
                    void updateAutomation('toolApproval', { policy: event.target.value as ToolApprovalPolicy })
                  }}
                >
                  <option value="off">{automationCopy.approval.off}</option>
                  <option value="safe">{automationCopy.approval.safe}</option>
                  <option value="strict">{automationCopy.approval.strict}</option>
                  <option value="paranoid">{automationCopy.approval.paranoid}</option>
                </select>
              </div>

              <dl className="mt-4 grid gap-3 border-t border-zinc-100 pt-4 text-xs leading-5 text-zinc-500">
                <div>
                  <dt className="font-medium text-zinc-700">{automationCopy.approval.note}</dt>
                  <dd className="mt-0.5">{approvalNotes[automation.toolApproval.policy]}</dd>
                </div>
              </dl>
            </section>

            {/* Sandbox */}
            <section className="eva-lift eva-panel mt-6 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-zinc-900">{automationCopy.sandbox.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-zinc-600">{automationCopy.sandbox.description}</p>
                </div>
                <select
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  value={automation.sandbox.level}
                  onChange={(event) => {
                    void updateAutomation('sandbox', { level: event.target.value as 'off' | 'permissive' | 'strict' })
                  }}
                >
                  <option value="off">{automationCopy.sandbox.off}</option>
                  <option value="permissive">{automationCopy.sandbox.permissive}</option>
                  <option value="strict">{automationCopy.sandbox.strict}</option>
                </select>
              </div>

              {automation.sandbox.level !== 'off' && (
                <dl className="mt-4 grid gap-3 border-t border-zinc-100 pt-4 text-xs leading-5 text-zinc-500">
                  <div>
                    <dt className="font-medium text-zinc-700">{automationCopy.sandbox.currentLevel}</dt>
                    <dd className="mt-0.5">{automation.sandbox.level}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-zinc-700">{automationCopy.sandbox.networkAccess}</dt>
                    <dd className="mt-0.5">
                      <label className="inline-flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={automation.sandbox.allowNetwork}
                          onChange={(event) => {
                            void updateAutomation('sandbox', { allowNetwork: event.target.checked })
                          }}
                          className="h-3.5 w-3.5 accent-violet-600"
                        />
                        {automation.sandbox.allowNetwork ? automationCopy.sandbox.networkAllowed : automationCopy.sandbox.networkBlocked}
                      </label>
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-zinc-700">{automationCopy.sandbox.note}</dt>
                    <dd className="mt-0.5">
                      {automation.sandbox.level === 'permissive'
                        ? automationCopy.sandbox.notePermissive
                        : automationCopy.sandbox.noteStrict}
                    </dd>
                  </div>
                </dl>
              )}
            </section>
          </fieldset>
        </TabsContent>

        <TabsContent value="agents" className="settings-dialog__content settings-dialog__content--agents">
          <AgentManagementWorkspace />
        </TabsContent>

        <TabsContent value="memory" className="settings-dialog__content">
          <LongTermMemoryPanel />
        </TabsContent>

        <TabsContent value="qq" className="settings-dialog__content">
          <div className="settings-qq-page">
            <header className="settings-section-heading settings-qq-heading">
              <div>
                <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
                  <Smartphone className="h-4 w-4 text-violet-500" />
                  {pageCopy.qq}
                </h2>
                <p className="mt-1 text-sm text-zinc-500">{pageCopy.qqHint}</p>
              </div>
              <label className="settings-toggle">
                <Switch
                  checked={qqConfig.enabled}
                  onChange={(event) => setQqConfig((config) => ({ ...config, enabled: event.target.checked }))}
                  disabled={qqSaving}
                />
                {pageCopy.enabled}
              </label>
            </header>

            <div className="settings-qq-layout">
              <div className="settings-qq-main">
                <fieldset disabled={qqSaving} className="settings-qq-fields">
                  <section className="settings-qq-section" aria-labelledby="qq-credentials-title">
                    <h3 id="qq-credentials-title" className="settings-form-section-title">
                      <Key className="h-4 w-4" />
                      {pageCopy.credentials}
                    </h3>
                    <div className="settings-qq-pair">
                      <div className="settings-dialog__field">
                        <label htmlFor="qq-app-id" className="settings-field-label">
                          AppID
                        </label>
                        <Input
                          id="qq-app-id"
                          value={qqConfig.appId}
                          onChange={(event) => setQqConfig((config) => ({ ...config, appId: event.target.value }))}
                          placeholder={pageCopy.appIdHint}
                          autoComplete="off"
                        />
                      </div>
                      <div className="settings-dialog__field">
                        <label htmlFor="qq-app-secret" className="settings-field-label">
                          AppSecret
                          {qqConfig.hasAppSecret && (
                            <span className="text-xs font-normal text-emerald-600">{pageCopy.secretSaved}</span>
                          )}
                        </label>
                        <div className="relative">
                          <Input
                            id="qq-app-secret"
                            type={showQqSecret ? 'text' : 'password'}
                            value={qqSecret}
                            onChange={(event) => setQqSecret(event.target.value)}
                            placeholder={qqConfig.hasAppSecret ? pageCopy.secretKeep : pageCopy.secretPlaceholder}
                            className="pr-9"
                            autoComplete="new-password"
                          />
                          <button
                            type="button"
                            onClick={() => setShowQqSecret((visible) => !visible)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-600"
                            aria-label={showQqSecret ? pageCopy.hideSecret : pageCopy.showSecret}
                          >
                            {showQqSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="settings-qq-section" aria-labelledby="qq-access-title">
                    <h3 id="qq-access-title" className="settings-form-section-title">
                      <ShieldCheck className="h-4 w-4" />
                      {pageCopy.access}
                    </h3>
                    <div className="settings-dialog__field">
                      <label htmlFor="qq-allowed-ids" className="settings-field-label">
                        {pageCopy.allowedIds}
                      </label>
                      <Input
                        id="qq-allowed-ids"
                        value={qqConfig.allowedUserIds.join(', ')}
                        onChange={(event) =>
                          setQqConfig((config) => ({
                            ...config,
                            allowedUserIds: event.target.value.split(/[\s,]+/).filter(Boolean),
                          }))
                        }
                        placeholder={pageCopy.allowedPlaceholder}
                      />
                      <p className="settings-field-hint">{pageCopy.openIdHint}</p>
                    </div>
                    <div className="settings-qq-pair">
                      <div className="settings-dialog__field">
                        <label htmlFor="qq-workspace" className="settings-field-label">
                          {pageCopy.workspace}
                        </label>
                        <Select
                          id="qq-workspace"
                          value={qqConfig.defaultWorkspaceId || ''}
                          onChange={(event) =>
                            setQqConfig((config) => ({ ...config, defaultWorkspaceId: event.target.value || null }))
                          }
                          options={[
                            { value: '', label: pageCopy.selectWorkspace },
                            ...(qqConfig.defaultWorkspaceId &&
                            !qqWorkspaces.some((workspace) => workspace.id === qqConfig.defaultWorkspaceId)
                              ? [
                                  {
                                    value: qqConfig.defaultWorkspaceId,
                                    label: pageCopy.missingWorkspace,
                                    disabled: true,
                                  },
                                ]
                              : []),
                            ...qqWorkspaces.map((workspace) => ({ value: workspace.id, label: workspace.name })),
                          ]}
                        />
                        <p className="settings-field-hint">{pageCopy.workspaceHint}</p>
                      </div>
                      <div className="settings-dialog__field">
                        <label htmlFor="qq-agent" className="settings-field-label">
                          {pageCopy.agent}
                        </label>
                        <Select
                          id="qq-agent"
                          value={qqConfig.defaultAgentId || ''}
                          onChange={(event) =>
                            setQqConfig((config) => ({ ...config, defaultAgentId: event.target.value || null }))
                          }
                          options={[
                            { value: '', label: pageCopy.defaultAgent },
                            ...(qqConfig.defaultAgentId &&
                            !qqAgents.some((agent) => agent.id === qqConfig.defaultAgentId)
                              ? [{ value: qqConfig.defaultAgentId, label: pageCopy.missingAgent, disabled: true }]
                              : []),
                            ...qqAgents.map((agent) => ({ value: agent.id, label: agent.name })),
                          ]}
                        />
                      </div>
                    </div>
                  </section>
                </fieldset>
                <div className="settings-form-actions">
                  {qqStatus.state === 'connected' || qqStatus.state === 'connecting' ? (
                    <Button variant="outline" onClick={disconnectQqRemote} disabled={qqSaving}>
                      {pageCopy.disconnect}
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={() => void saveQqRemote(false)} disabled={qqSaving}>
                    {pageCopy.save}
                  </Button>
                  <Button onClick={() => void saveQqRemote(true)} disabled={qqSaving || qqSetupIssues.length > 0} className="min-w-[116px]">
                    {qqSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    {qqSaving ? pageCopy.working : pageCopy.connect}
                  </Button>
                </div>
                {qqResult && (
                  <div
                    className="settings-dialog__result"
                    role="status"
                    data-status={qqResult.success ? 'success' : 'error'}
                  >
                    {qqResult.success ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 shrink-0" />
                    )}
                    {qqResult.message}
                  </div>
                )}
              </div>
              <aside
                className="settings-connection-status"
                data-state={qqStatus.state}
                aria-labelledby="qq-status-title"
              >
                <div className="settings-field-hint">{pageCopy.connectionStatus}</div>
                <div className="settings-connection-state" role="status">
                  {qqStatus.state === 'connected' ? (
                    <CheckCircle2 className="h-5 w-5" />
                  ) : qqStatus.state === 'error' ? (
                    <AlertCircle className="h-5 w-5" />
                  ) : qqStatus.state === 'connecting' ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Smartphone className="h-5 w-5" />
                  )}
                  <h3 id="qq-status-title">{pageCopy[qqStatus.state]}</h3>
                </div>
                <p className="settings-field-hint settings-connection-detail">
                  {qqStatus.message.trim() === 'QQ did not return an access token.'
                    ? pageCopy.tokenError
                    : qqStatus.message}
                </p>
                {qqSetupIssues.length > 0 && <div className="settings-setup-issues"><h4>{pageCopy.setupRequired}</h4><ul>{qqSetupIssues.map(issue => <li key={issue.field}><button type="button" onClick={() => { const field = document.getElementById(issue.field); field?.scrollIntoView({ block: 'center', behavior: 'auto' }); field?.focus() }}>{issue.text}</button></li>)}</ul></div>}
                <div className="settings-connection-environment">
                  <label className="settings-toggle">
                    <Switch
                      checked={qqConfig.sandbox}
                      disabled={qqSaving}
                      onChange={(event) => setQqConfig((config) => ({ ...config, sandbox: event.target.checked }))}
                    />
                    {pageCopy.sandbox}
                  </label>
                  <p className="settings-field-hint">{pageCopy.sandboxHint}</p>
                </div>
              </aside>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="app-server" className="settings-dialog__content">
          <AppServerPanel />
        </TabsContent>

      </Tabs>
    </section>
  )
}
