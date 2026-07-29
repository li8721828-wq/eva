import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { useTaskStore } from '@/stores/use-task-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { ReferenceImagePreview } from './ReferenceImagePreview'
import { Bot, FolderOpen, FolderPlus, ImagePlus, Paperclip, Send, Square, Trash2, X } from 'lucide-react'
import type { ChatImageAttachment, ConversationPermissionLevel, FileAccessGrant } from '../../../shared/types'
import type { ProviderConfigEntry } from '../../../shared/types/provider'

export interface InputBarProps {
  className?: string
}

function getConnectionDisplayName(provider: ProviderConfigEntry): string {
  const defaultNames: Record<ProviderConfigEntry['type'], string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    deepseek: 'DeepSeek',
    custom: 'Custom (OpenAI-compatible)',
  }
  return provider.name === defaultNames[provider.type]
    ? (provider.type === 'custom' ? 'Custom' : defaultNames[provider.type])
    : provider.name
}

export function InputBar({ className }: InputBarProps) {
  const { conversations, createConversation, currentConversationId, isStreaming, inputText, referenceImages, setConversationAgent, setConversationPermissions, setInputText, setReferenceImages, sendMessage, abortStream, addMessage } = useChatStore()
  const { activeProviderId, activeModel, settingsOpen, setActiveProvider, setActiveModel, workMode } = useAppStore()
  const { agents, selectedAgentId, selectAgent } = useAgentStore()
  const isTaskRunning = useTaskStore((state) => Boolean(currentConversationId && state.expertTasks[currentConversationId]?.isRunning))
  const { startExpertTask, abortExpertTask } = useTaskStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isDraggingImages, setIsDraggingImages] = useState(false)
  const [savedProviders, setSavedProviders] = useState<ProviderConfigEntry[]>([])
  const currentConversation = conversations.find((conversation) => conversation.id === currentConversationId)
  const permissionLevel: ConversationPermissionLevel = currentConversation?.permissionLevel || (currentConversation?.accessScope === 'full' ? 'full-access' : 'workspace')
  const fileAccessGrants = currentConversation?.fileAccessGrants || []
  const activeAgentId = currentConversation?.agentId || selectedAgentId || ''

  const connectionOptions = useMemo(() => {
    const enabled = savedProviders.filter((provider) => provider.isEnabled && provider.apiKey)
    const options = enabled.map((provider) => ({ value: provider.id, label: getConnectionDisplayName(provider) }))
    const active = savedProviders.find((provider) => provider.id === activeProviderId)
    if (activeProviderId && !options.some((option) => option.value === activeProviderId)) {
      options.unshift({ value: activeProviderId, label: active ? getConnectionDisplayName(active) : 'Current connection' })
    }
    return options.length > 0 ? options : [{ value: '', label: 'No model connections' }]
  }, [activeProviderId, savedProviders])

  const activeConnectionModels = useMemo(() => {
    const provider = savedProviders.find((item) => item.id === activeProviderId)
    const models = provider?.models?.length
      ? provider.models
      : provider?.defaultModel
        ? [{ id: provider.defaultModel, name: provider.defaultModel }]
        : []
    const options = models.map((model) => ({ value: model.id, label: model.name }))
    if (activeModel && !options.some((option) => option.value === activeModel)) {
      options.unshift({ value: activeModel, label: activeModel })
    }
    return options.length > 0 ? options : [{ value: '', label: 'No models in connection' }]
  }, [activeModel, activeProviderId, savedProviders])

  useEffect(() => {
    let cancelled = false
    void window.eva.provider.list()
      .then((providers) => { if (!cancelled) setSavedProviders(providers) })
      .catch((error) => console.error('Failed to load saved provider profiles:', error))
    return () => { cancelled = true }
  }, [activeProviderId, activeModel, settingsOpen])

  const handleSend = useCallback(async () => {
    if ((!inputText.trim() && referenceImages.length === 0) || isStreaming || isTaskRunning) return
    const useTeam = workMode === 'expert'
    if (useTeam) {
      const goal = inputText.trim()
      if (!goal) return
      const conversation = currentConversation || await createConversation(activeAgentId, 'expert')
      addMessage({
        id: crypto.randomUUID(),
        conversationId: conversation.id,
        role: 'user',
        content: goal,
        timestamp: Date.now(),
      })
      setInputText('')
      setReferenceImages([])
      await startExpertTask(goal, conversation.id)
    } else {
      await sendMessage()
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [activeAgentId, addMessage, createConversation, currentConversation, inputText, isStreaming, isTaskRunning, referenceImages.length, sendMessage, setInputText, setReferenceImages, startExpertTask, workMode])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value)
    // Auto-resize
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  const handleStop = () => {
    if (workMode === 'expert' && isTaskRunning) {
      void abortExpertTask(currentConversationId || undefined)
      return
    }
    abortStream()
  }

  const addReferenceFiles = useCallback((selected: File[]) => {
    if (!selected.length) return

    const slots = 4 - referenceImages.length
    if (slots <= 0) {
      setAttachmentError('You can attach up to four reference images.')
      return
    }

    const supported = selected.filter((file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    let validationMessage: string | null = supported.length !== selected.length ? 'Use JPG, PNG, or WebP reference images.' : null
    const sized = supported.filter((file) => file.size <= 12 * 1024 * 1024).slice(0, slots)
    if (sized.length !== supported.length) validationMessage = 'Each reference image must be 12 MB or smaller.'

    const additions: ChatImageAttachment[] = sized
      .map((file) => ({ path: window.eva.file.getPath(file), name: file.name, mediaType: file.type as ChatImageAttachment['mediaType'], size: file.size }))
      .filter((image) => image.path)
    if (additions.length) {
      setReferenceImages([...referenceImages, ...additions])
    }
    setAttachmentError(validationMessage)
  }, [referenceImages, setReferenceImages])

  const addReferenceImages = (event: React.ChangeEvent<HTMLInputElement>) => {
    addReferenceFiles(Array.from(event.target.files || []))
    event.target.value = ''
  }

  const handleImageDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDraggingImages(false)
    addReferenceFiles(Array.from(event.dataTransfer.files))
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (pastedImages.length) {
      event.preventDefault()
      addReferenceFiles(pastedImages)
    }
  }

  const removeReferenceImage = (path: string) => {
    setReferenceImages(referenceImages.filter((image) => image.path !== path))
    setAttachmentError(null)
  }

  const saveModelSelection = async (providerId: string, model: string) => {
    if (providerId === activeProviderId && model === activeModel) return
    setActiveProvider(providerId)
    setActiveModel(model)
    try {
      await window.eva.config.set('activeProviderId', providerId)
      await window.eva.config.set('activeModel', model)
    } catch (error) {
      setActiveProvider(activeProviderId)
      setActiveModel(activeModel)
      console.error('Failed to save active model:', error)
    }
  }

  const handleConnectionChange = async (providerId: string) => {
    const provider = savedProviders.find((item) => item.id === providerId)
    if (!provider) return
    const models = provider.models?.length
      ? provider.models
      : provider.defaultModel
        ? [{ id: provider.defaultModel, name: provider.defaultModel }]
        : []
    const model = models.some((item) => item.id === activeModel)
      ? activeModel
      : models[0]?.id || ''
    await saveModelSelection(providerId, model)
  }

  const handleModelChange = async (model: string) => {
    if (!activeProviderId || !model) return
    await saveModelSelection(activeProviderId, model)
  }

  const handlePermissionChange = async (permission: ConversationPermissionLevel) => {
    const conversation = currentConversation || await createConversation()
    await setConversationPermissions(conversation.id, permission, conversation.fileAccessGrants || [])
  }

  const handleAgentChange = async (agentId: string) => {
    if (!agentId) return
    selectAgent(agentId)
    const conversation = currentConversation || await createConversation(agentId)
    await setConversationAgent(conversation.id, agentId)
  }

  const addFolderGrant = async () => {
    if (!currentConversation) return
    const path = await window.eva.file.selectFolder()
    if (!path || fileAccessGrants.some((grant) => grant.path === path)) return
    void setConversationPermissions(currentConversation.id, 'granted-folders', [
      ...fileAccessGrants,
      { path, access: 'read-write' },
    ])
  }

  const updateFolderGrant = (path: string, access: FileAccessGrant['access']) => {
    if (!currentConversation) return
    void setConversationPermissions(
      currentConversation.id,
      'granted-folders',
      fileAccessGrants.map((grant) => (grant.path === path ? { ...grant, access } : grant))
    )
  }

  const removeFolderGrant = (path: string) => {
    if (!currentConversation) return
    void setConversationPermissions(
      currentConversation.id,
      'granted-folders',
      fileAccessGrants.filter((grant) => grant.path !== path)
    )
  }

  return (
    <div className={cn('border-t border-zinc-200 bg-zinc-50/80 px-8 py-5', className)}>
      <div className="w-full">
        <div
          className={cn('chat-composer overflow-hidden rounded-lg border bg-white shadow-sm transition-colors duration-200 focus-within:border-zinc-400 focus-within:shadow-md', isDraggingImages ? 'border-violet-500 bg-violet-50/30' : 'border-zinc-300')}
          onDragOver={(event) => { event.preventDefault(); setIsDraggingImages(true) }}
          onDragLeave={() => setIsDraggingImages(false)}
          onDrop={handleImageDrop}
        >
          <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" onChange={addReferenceImages} />
          {referenceImages.length > 0 && (
            <div className="flex flex-wrap gap-2 border-b border-zinc-100 px-4 py-3">
              {referenceImages.map((image) => (
                <div key={image.path} className="group relative h-16 w-16 overflow-hidden rounded-md border border-zinc-200 bg-zinc-100">
                  <ReferenceImagePreview image={image} className="h-full w-full" />
                  <button type="button" onClick={() => removeReferenceImage(image.path)} className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-zinc-950/75 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100" title={`Remove ${image.name}`} aria-label={`Remove ${image.name}`}>
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <div className="flex min-w-0 flex-col justify-center text-xs leading-5 text-zinc-500">
                <span className="font-medium text-zinc-700">Reference images</span>
                <span>Agent will use these views to build a new editable model.</span>
              </div>
            </div>
          )}
          <div className="flex min-h-16 items-end gap-3 px-4 py-3">
            <Button
              variant="ghost"
              size="icon"
              className="mb-0.5 h-8 w-8 shrink-0 text-zinc-400 hover:text-zinc-700"
              title="Attach file"
              aria-label="Attach reference images"
              onClick={() => imageInputRef.current?.click()}
            >
            {referenceImages.length ? <ImagePlus className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
            </Button>

            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Ask Eva to write, debug, or explain code"
              rows={1}
              className="chat-composer__textarea max-h-[200px] min-h-[32px] flex-1 resize-none bg-transparent py-1.5 text-sm leading-5 text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
            />

            {isStreaming || isTaskRunning ? (
              <button
                className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500 text-white transition-colors hover:bg-red-600"
                onClick={handleStop}
                title={isTaskRunning ? 'Stop team' : 'Stop'}
                aria-label={isTaskRunning ? 'Stop team' : 'Stop generating'}
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                className={cn(
                  'mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
                  inputText.trim() || referenceImages.length > 0
                    ? 'bg-violet-600 text-white hover:bg-violet-700'
                    : 'bg-zinc-100 text-zinc-400'
                )}
                onClick={handleSend}
                disabled={!inputText.trim() && referenceImages.length === 0}
                title="Send"
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>

          {attachmentError && <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{attachmentError}</div>}

          <div className="flex min-h-11 items-center justify-between gap-4 border-t border-zinc-100 bg-zinc-50 px-4 py-2.5 text-xs text-zinc-500">
            <div className="flex min-w-0 items-center gap-2">
              <Bot className="h-3.5 w-3.5 shrink-0 text-violet-500" />
              <div className="w-[176px]">
                <Select
                  value={activeAgentId}
                  onChange={(event) => void handleAgentChange(event.target.value)}
                  options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
                  className="h-8 border-transparent bg-transparent text-xs font-medium text-zinc-700 shadow-none hover:bg-white/70 focus:border-zinc-300 focus:bg-white focus:shadow-sm focus:ring-0 focus-visible:border-zinc-300 focus-visible:ring-0"
                  aria-label="Select agent"
                  title={currentConversation ? 'Agent for this conversation' : 'Select an agent to create a draft conversation'}
                />
              </div>
              <div className="h-4 w-px shrink-0 bg-zinc-200" aria-hidden="true" />
              <div className="w-[144px]">
                <Select
                  value={activeProviderId}
                  onChange={(event) => void handleConnectionChange(event.target.value)}
                  options={connectionOptions}
                  className="h-8 border-transparent bg-transparent text-xs font-medium text-zinc-700 shadow-none hover:bg-white/70 focus:border-zinc-300 focus:bg-white focus:shadow-sm focus:ring-0 focus-visible:border-zinc-300 focus-visible:ring-0"
                  aria-label="Select model connection"
                  title="Select model connection"
                />
              </div>
              <div className="h-4 w-px shrink-0 bg-zinc-200" aria-hidden="true" />
              <div className="w-[170px]">
                <Select
                  value={activeModel}
                  onChange={(event) => void handleModelChange(event.target.value)}
                  options={activeConnectionModels}
                  disabled={activeConnectionModels.length === 1 && !activeConnectionModels[0].value}
                  className="h-8 border-transparent bg-transparent text-xs font-medium text-zinc-700 shadow-none hover:bg-white/70 focus:border-zinc-300 focus:bg-white focus:shadow-sm focus:ring-0 focus-visible:border-zinc-300 focus-visible:ring-0"
                  aria-label="Select model from connection"
                  title="Select model in this connection"
                />
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <div className="h-4 w-px shrink-0 bg-zinc-200" aria-hidden="true" />
              <div className="w-[176px]">
                <Select
                  value={permissionLevel}
                  onChange={(event) => void handlePermissionChange(event.target.value as ConversationPermissionLevel)}
                  options={[
                    { value: 'workspace', label: 'Workspace only' },
                    { value: 'granted-folders', label: 'Authorized folders' },
                    { value: 'full-access', label: 'Full filesystem access' },
                  ]}
                  className="h-8 border-transparent bg-transparent text-xs font-medium text-zinc-700 shadow-none hover:bg-white/70 focus:border-zinc-300 focus:bg-white focus:shadow-sm focus:ring-0 focus-visible:border-zinc-300 focus-visible:ring-0"
                  aria-label="Conversation file permission"
                  title={currentConversation ? 'File access for this conversation' : 'Select a permission to create a draft conversation'}
                />
              </div>
            </div>
            <span className="shrink-0 text-zinc-400">Shift+Enter for a new line</span>
          </div>

          {currentConversation && permissionLevel === 'granted-folders' && (
            <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 bg-white px-4 py-2.5">
              {fileAccessGrants.map((grant) => (
                <div key={grant.path} className="flex max-w-full items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 py-1 pl-2 pr-1 text-xs text-zinc-600">
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                  <span className="max-w-[200px] truncate" title={grant.path}>{grant.path}</span>
                  <Select
                    value={grant.access}
                    onChange={(event) => updateFolderGrant(grant.path, event.target.value as FileAccessGrant['access'])}
                    options={[
                      { value: 'read', label: 'Read' },
                      { value: 'read-write', label: 'Read & write' },
                    ]}
                    className="h-6 min-w-[92px] rounded border-transparent bg-transparent px-1 text-[11px] shadow-none hover:bg-white focus-visible:border-zinc-300"
                    aria-label={`File access for ${grant.path}`}
                  />
                  <button type="button" onClick={() => removeFolderGrant(grant.path)} className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600" title="Remove folder access" aria-label="Remove folder access">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs text-violet-700 hover:text-violet-800" onClick={() => void addFolderGrant()}>
                <FolderPlus className="h-3.5 w-3.5" />
                Add folder
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
