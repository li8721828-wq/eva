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
} from 'lucide-react'
import type { ProviderConfigEntry, ProviderModelOption, ProviderTestConfig } from '../../../shared/types/provider'
import evaMark from '@/assets/eva-mark.svg'

type ProviderType = ProviderConfigEntry['type']

const PROVIDER_OPTIONS: Array<{ value: ProviderType; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)' },
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
