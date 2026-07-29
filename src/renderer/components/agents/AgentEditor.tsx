import React, { useState, useEffect, useMemo } from 'react'
import type { AgentConfig, AgentRole } from '../../../shared/types'
import { AGENT_ROLES, DEFAULT_MODELS } from '../../../shared/constants'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { ToolAccessPanel } from './ToolAccessPanel'
import { Save, X } from 'lucide-react'

export interface AgentEditorProps {
  agent?: AgentConfig
  defaultProviderId?: string
  defaultModel?: string
  /** Available provider IDs loaded from backend */
  availableProviders?: string[]
  onSave?: (agent: Partial<AgentConfig>) => void
  onCancel?: () => void
  className?: string
}

const roleOptions = (Object.entries(AGENT_ROLES) as [string, { label: string; description: string }][]).map(
  ([value, info]) => ({
    value,
    label: info.label,
  })
)

export function AgentEditor({
  agent,
  defaultProviderId = 'openai',
  defaultModel = '',
  availableProviders,
  onSave,
  onCancel,
  className,
}: AgentEditorProps) {
  const [name, setName] = useState(agent?.name || '')
  const [description, setDescription] = useState(agent?.description || '')
  const [role, setRole] = useState<AgentRole>(agent?.role || 'custom')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '')
  const [providerId, setProviderId] = useState(agent?.providerId || defaultProviderId)
  const [model, setModel] = useState(agent?.model || defaultModel)
  const [temperature, setTemperature] = useState(agent?.temperature ?? 0.7)
  const [maxIterations, setMaxIterations] = useState(agent?.maxIterations ?? 20)
  const [tools, setTools] = useState<string[]>(agent?.tools || [])
  const [nameError, setNameError] = useState('')

  // Sync form when agent prop changes
  useEffect(() => {
    if (agent) {
      setName(agent.name)
      setDescription(agent.description)
      setRole(agent.role)
      setSystemPrompt(agent.systemPrompt)
      setProviderId(agent.providerId)
      setModel(agent.model)
      setTemperature(agent.temperature)
      setMaxIterations(agent.maxIterations)
      setTools(agent.tools)
      setNameError('')
    }
  }, [agent?.id])

  // Build model options based on selected provider
  const modelOptions = useMemo(() => {
    const models = DEFAULT_MODELS[providerId] || []
    const options = models.map((modelInfo) => ({ value: modelInfo.id, label: modelInfo.name }))
    if (model && !options.some((option) => option.value === model)) {
      options.unshift({ value: model, label: model })
    }
    return options
  }, [providerId, model])

  // Reset model when provider changes
  const handleProviderChange = (newProviderId: string) => {
    setProviderId(newProviderId)
    const models = DEFAULT_MODELS[newProviderId] || []
    if (models.length > 0 && !models.find((m) => m.id === model)) {
      setModel(models[0].id)
    }
  }

  // Set default model if empty
  useEffect(() => {
    if (!model && modelOptions.length > 0) {
      setModel(modelOptions[0].value)
    }
  }, [modelOptions, model])

  const providerOptions = useMemo(() => {
    const providers = availableProviders || Object.keys(DEFAULT_MODELS)
    return providers.map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }))
  }, [availableProviders])

  const handleSave = () => {
    if (!name.trim()) {
      setNameError('Name is required')
      return
    }
    setNameError('')
    onSave?.({
      name: name.trim(),
      description,
      role,
      systemPrompt,
      providerId,
      model,
      temperature,
      maxIterations,
      tools,
    })
  }

  return (
    <div className={cn('flex flex-col gap-4 p-4', className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-800">{agent ? 'Edit Agent' : 'New Agent'}</h3>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} className="gap-1.5">
              <X className="h-3.5 w-3.5" />
              Cancel
            </Button>
          )}
          <Button size="sm" onClick={handleSave} className="gap-1.5">
            <Save className="h-3.5 w-3.5" />
            Save
          </Button>
        </div>
      </div>

      {/* Name + Role */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-500">
            Name <span className="text-red-400">*</span>
          </label>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (nameError) setNameError('')
            }}
            placeholder="e.g. Researcher Jack"
            className={nameError ? 'border-red-500' : ''}
          />
          {nameError && <p className="text-xs text-red-500">{nameError}</p>}
          <p className="text-xs leading-5 text-zinc-500">Roles are reusable templates. Give each Agent an individual name, such as Researcher Jack or Researcher Lucy.</p>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-500">Role</label>
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as AgentRole)}
            options={roleOptions}
          />
        </div>
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-zinc-500">Description</label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Brief description of what this agent does"
        />
      </div>

      {/* System Prompt */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-zinc-500">System Prompt</label>
        <Textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="You are an expert..."
          rows={10}
          className="font-mono text-xs"
        />
      </div>

      {/* Provider + Model (cascading) */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-500">Provider</label>
          <Select
            value={providerId}
            onChange={(e) => handleProviderChange(e.target.value)}
            options={providerOptions}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-500">Model</label>
          <Select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            options={modelOptions}
          />
        </div>
      </div>

      {/* Temperature + Max Iterations */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-500">Temperature: {temperature.toFixed(1)}</label>
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
            className="w-full accent-violet-600"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-500">Max Iterations</label>
          <Input
            type="number"
            min={1}
            max={100}
            value={maxIterations}
            onChange={(e) => setMaxIterations(parseInt(e.target.value, 10) || 20)}
            placeholder="20"
          />
        </div>
      </div>

      <ToolAccessPanel tools={tools} onChange={setTools} />
    </div>
  )
}
