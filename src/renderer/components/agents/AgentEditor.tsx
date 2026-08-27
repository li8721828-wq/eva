import React, { useState, useEffect, useMemo } from 'react'
import type { AgentConfig, AgentRole } from '../../../shared/types'
import { AGENT_ROLES, DEFAULT_MODELS } from '../../../shared/constants'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { ToolAccessPanel } from './ToolAccessPanel'
import { OutputFormatPanel } from './OutputFormatPanel'
import { Save, X } from 'lucide-react'
import { uiCopy } from '@/lib/ui-copy'
import { useAppStore } from '@/stores/use-app-store'

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
  const language = useAppStore((state) => state.language)
  const copy = uiCopy[language].agents
  const [name, setName] = useState(agent?.name || '')
  const [description, setDescription] = useState(agent?.description || '')
  const [role, setRole] = useState<AgentRole>(agent?.role || 'custom')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '')
  const [processOutput, setProcessOutput] = useState<NonNullable<AgentConfig['processOutput']>>(agent?.processOutput || (agent?.showThinking ? 'detailed' : 'compact'))
  const [outputFormat, setOutputFormat] = useState<NonNullable<AgentConfig['outputFormat']>>(agent?.outputFormat || 'default')
  const [outputFormatInstructions, setOutputFormatInstructions] = useState(agent?.outputFormatInstructions || '')
  const [outputStyle, setOutputStyle] = useState<NonNullable<AgentConfig['outputStyle']>>(agent?.outputStyle || 'balanced')
  const [outputFont, setOutputFont] = useState<NonNullable<AgentConfig['outputFont']>>(agent?.outputFont || 'system')
  const [outputColor, setOutputColor] = useState<NonNullable<AgentConfig['outputColor']>>(agent?.outputColor || 'slate')
  const [outputFontSize, setOutputFontSize] = useState<NonNullable<AgentConfig['outputFontSize']>>(agent?.outputFontSize || 'medium')
  const [outputTextEffect, setOutputTextEffect] = useState<NonNullable<AgentConfig['outputTextEffect']>>(agent?.outputTextEffect || 'none')
  const [markdownRenderer, setMarkdownRenderer] = useState<NonNullable<AgentConfig['markdownRenderer']>>(agent?.markdownRenderer || 'enhanced')
  const [providerId, setProviderId] = useState(agent?.providerId || defaultProviderId)
  const [model, setModel] = useState(agent?.model || defaultModel)
  const [temperature, setTemperature] = useState(agent?.temperature ?? 0.7)
  const [maxIterations, setMaxIterations] = useState(agent?.maxIterations ?? 100)
  const [tools, setTools] = useState<string[]>(agent?.tools || [])
  const [nameError, setNameError] = useState('')

  // Sync form when agent prop changes
  useEffect(() => {
    if (agent) {
      setName(agent.name)
      setDescription(agent.description)
      setRole(agent.role)
      setSystemPrompt(agent.systemPrompt)
      setProcessOutput(agent.processOutput || (agent.showThinking ? 'detailed' : 'compact'))
      setOutputFormat(agent.outputFormat || 'default')
      setOutputFormatInstructions(agent.outputFormatInstructions || '')
      setOutputStyle(agent.outputStyle || 'balanced')
      setOutputFont(agent.outputFont || 'system')
      setOutputColor(agent.outputColor || 'slate')
      setOutputFontSize(agent.outputFontSize || 'medium')
      setOutputTextEffect(agent.outputTextEffect || 'none')
      setMarkdownRenderer(agent.markdownRenderer || 'enhanced')
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
      setNameError(copy.nameRequired)
      return
    }
    setNameError('')
    onSave?.({
      name: name.trim(),
      description,
      role,
      systemPrompt,
      processOutput,
      showThinking: processOutput === 'detailed',
      outputFormat,
      outputFormatInstructions: outputFormat === 'custom' ? outputFormatInstructions.trim() : '',
      outputStyle,
      outputFont,
      outputColor,
      outputFontSize,
      outputTextEffect,
      markdownRenderer,
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
        <h3 className="text-sm font-medium text-zinc-800">{agent ? copy.edit : copy.create}</h3>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} className="gap-1.5">
              <X className="h-3.5 w-3.5" />
              {copy.cancel}
            </Button>
          )}
          <Button size="sm" onClick={handleSave} className="gap-1.5">
            <Save className="h-3.5 w-3.5" />
            {language === 'zh' ? '保存' : language === 'ja' ? '保存' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Name + Role */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-500">
            {copy.name} <span className="text-red-400">*</span>
          </label>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (nameError) setNameError('')
            }}
            placeholder={language === 'zh' ? '例如：研究员小王' : language === 'ja' ? '例：リサーチャー田中' : 'e.g. Researcher Jack'}
            className={nameError ? 'border-red-500' : ''}
          />
          {nameError && <p className="text-xs text-red-500">{nameError}</p>}
          <p className="text-xs leading-5 text-zinc-500">{copy.nameHint}</p>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-500">{copy.role}</label>
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as AgentRole)}
            options={roleOptions}
          />
        </div>
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-zinc-500">{copy.descriptionLabel}</label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={language === 'zh' ? '简要说明该智能体的职责' : language === 'ja' ? 'このエージェントの役割を簡潔に説明' : 'Brief description of what this agent does'}
        />
      </div>

      {/* System Prompt */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-zinc-500">{copy.systemPrompt}</label>
        <Textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={language === 'zh' ? '你是一名专业的…' : language === 'ja' ? 'あなたは専門家です…' : 'You are an expert...'}
          rows={10}
          className="font-mono text-xs"
        />
      </div>

      <OutputFormatPanel
        outputFormat={outputFormat}
        outputFormatInstructions={outputFormatInstructions}
        outputStyle={outputStyle}
        outputFont={outputFont}
        outputColor={outputColor}
        outputFontSize={outputFontSize}
        outputTextEffect={outputTextEffect}
        markdownRenderer={markdownRenderer}
        processOutput={processOutput}
        onOutputFormatChange={setOutputFormat}
        onOutputFormatInstructionsChange={setOutputFormatInstructions}
        onOutputStyleChange={setOutputStyle}
        onOutputFontChange={setOutputFont}
        onOutputColorChange={setOutputColor}
        onOutputFontSizeChange={setOutputFontSize}
        onOutputTextEffectChange={setOutputTextEffect}
        onMarkdownRendererChange={setMarkdownRenderer}
        onProcessOutputChange={setProcessOutput}
      />

      {/* Provider + Model (cascading) */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-500">{copy.provider}</label>
          <Select
            value={providerId}
            onChange={(e) => handleProviderChange(e.target.value)}
            options={providerOptions}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-500">{copy.model}</label>
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
          <label className="text-sm font-medium text-zinc-500">{copy.temperature}: {temperature.toFixed(1)}</label>
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
          <label className="text-sm font-medium text-zinc-500">{copy.iterationLimit}</label>
          <Input
            type="number"
            min={1}
            max={100}
            value={maxIterations}
            onChange={(e) => setMaxIterations(parseInt(e.target.value, 10) || 100)}
            placeholder="100"
          />
        </div>
      </div>

      <ToolAccessPanel tools={tools} onChange={setTools} />
    </div>
  )
}
