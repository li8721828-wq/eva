import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { useTaskStore } from '@/stores/use-task-store'
import { useSymposiumStore } from '@/stores/use-symposium-store'
import { cn } from '@/lib/utils'
import { shouldUseExpertTeam } from '@/lib/team-routing'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { ReferenceImagePreview } from './ReferenceImagePreview'
import { Bot, FileText, FolderOpen, ImagePlus, Paperclip, Send, Settings2, Square, X } from 'lucide-react'
import type { ChatDocumentAttachment, ChatImageAttachment, ConversationPermissionLevel } from '../../../shared/types'
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
  const { conversations, createConversation, currentConversationId, streamingByConversation, inputText, referenceImages, documentAttachments, setConversationAgent, setConversationPermissions, setInputText, setReferenceImages, setDocumentAttachments, sendMessage, abortStream, addMessage, setError } = useChatStore()
  const isStreaming = Boolean(currentConversationId && streamingByConversation[currentConversationId]?.isStreaming)
  const { activeProviderId, activeModel, settingsOpen, setActiveProvider, setActiveModel, workMode } = useAppStore()
  const { agents } = useAgentStore()
  const isTaskRunning = useTaskStore((state) => Boolean(currentConversationId && state.expertTasks[currentConversationId]?.isRunning))
  const isSymposiumRunning = useSymposiumStore((state) => Boolean(currentConversationId && state.runtimes[currentConversationId]?.status === 'running'))
  const { startExpertTask, abortExpertTask } = useTaskStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isDraggingAttachments, setIsDraggingAttachments] = useState(false)
  const [savedProviders, setSavedProviders] = useState<ProviderConfigEntry[]>([])
  const [isConversationSettingsOpen, setIsConversationSettingsOpen] = useState(false)
  const [caretPosition, setCaretPosition] = useState(0)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [assignedAgentId, setAssignedAgentId] = useState<string | null>(null)
  const currentConversation = conversations.find((conversation) => conversation.id === currentConversationId)
  const isSymposiumConversation = Boolean(currentConversation?.symposium)
  const symposiumMentionOptions = currentConversation?.symposium?.participants || []
  const permissionLevel: ConversationPermissionLevel = currentConversation?.permissionLevel || (currentConversation?.accessScope === 'full' ? 'full-access' : 'workspace')
  const assignedAgent = agents.find((agent) => agent.id === assignedAgentId)

  const symposiumMention = useMemo(() => {
    if (!isSymposiumConversation) return null
    const cursor = Math.min(caretPosition, inputText.length)
    const beforeCursor = inputText.slice(0, cursor)
    const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/)
    if (!match) return null
    return {
      query: match[2].toLowerCase(),
      start: cursor - match[0].length + match[1].length,
      cursor,
    }
  }, [caretPosition, inputText, isSymposiumConversation])

  const filteredSymposiumMentionOptions = useMemo(() => {
    if (!symposiumMention) return []
    return symposiumMentionOptions.filter((participant) => {
      const handle = participant.handle || participant.modelName || participant.model || participant.providerName || participant.id
      const searchable = `${handle} ${participant.providerName} ${participant.modelName} ${participant.model}`.toLowerCase()
      return searchable.includes(symposiumMention.query)
    })
  }, [symposiumMention, symposiumMentionOptions])

  const agentMention = useMemo(() => {
    if (isSymposiumConversation) return null
    const cursor = Math.min(caretPosition, inputText.length)
    const beforeCursor = inputText.slice(0, cursor)
    const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/)
    if (!match) return null
    return {
      query: match[2].toLowerCase(),
      start: cursor - match[0].length + match[1].length,
      cursor,
    }
  }, [caretPosition, inputText, isSymposiumConversation])

  const filteredAgentMentionOptions = useMemo(() => {
    if (!agentMention) return []
    return agents.filter((agent) => (
      `${agent.name} ${agent.role} ${agent.description}`.toLowerCase().includes(agentMention.query)
    )).slice(0, 8)
  }, [agentMention, agents])

  useEffect(() => {
    setActiveMentionIndex(0)
  }, [agentMention?.query, symposiumMention?.query, currentConversationId])

  useEffect(() => {
    const conversationAgentId = currentConversation?.agentId
    setAssignedAgentId(conversationAgentId && conversationAgentId !== '__auto__' ? conversationAgentId : null)
  }, [currentConversation?.agentId, currentConversationId])

  const modelChoices = useMemo(() => {
    const visibleProviders = savedProviders.filter((provider) => (
      (provider.isEnabled && provider.apiKey) || provider.id === activeProviderId
    ))
    const choices = visibleProviders.flatMap((provider) => {
      const models = provider.models?.length
        ? provider.models
        : provider.defaultModel
          ? [{ id: provider.defaultModel, name: provider.defaultModel }]
          : []
      return models.map((model) => ({
        value: `${provider.id}\u001f${model.id}`,
        providerId: provider.id,
        modelId: model.id,
        label: `${getConnectionDisplayName(provider)} / ${model.name}`,
      }))
    })
    if (activeProviderId && activeModel && !choices.some((choice) => choice.providerId === activeProviderId && choice.modelId === activeModel)) {
      const active = savedProviders.find((provider) => provider.id === activeProviderId)
      choices.unshift({
        value: `${activeProviderId}\u001f${activeModel}`,
        providerId: activeProviderId,
        modelId: activeModel,
        label: `${active ? getConnectionDisplayName(active) : 'Current connection'} / ${activeModel}`,
      })
    }
    return choices
  }, [activeModel, activeProviderId, savedProviders])

  const activeModelChoice = modelChoices.find((choice) => (
    choice.providerId === activeProviderId && choice.modelId === activeModel
  ))?.value || ''

  const modelChoiceOptions = modelChoices.length > 0
    ? modelChoices.map(({ value, label }) => ({ value, label }))
    : [{ value: '', label: 'No model connections', disabled: true }]

  useEffect(() => {
    let cancelled = false
    void window.eva.provider.list()
      .then((providers) => { if (!cancelled) setSavedProviders(providers) })
      .catch((error) => console.error('Failed to load saved provider profiles:', error))
    return () => { cancelled = true }
  }, [activeProviderId, activeModel, settingsOpen])

  const handleSend = useCallback(async () => {
    if ((!inputText.trim() && referenceImages.length === 0) || isStreaming || isTaskRunning || isSymposiumRunning) return
    if (currentConversation?.symposium) {
      if (referenceImages.length > 0) {
        setError('Reference images are not supported inside Agent Symposium yet.')
        return
      }
      try {
        await window.eva.symposium.continue({ conversationId: currentConversation.id, content: inputText.trim() })
        setInputText('')
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Could not continue the Symposium.')
      }
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }
    const useTeam = workMode === 'expert' && shouldUseExpertTeam(inputText)
    if (useTeam) {
      const goal = inputText.trim()
      if (!goal) return
      const conversation = currentConversation || await createConversation(undefined, 'expert')
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
      await sendMessage(assignedAgentId || '__auto__')
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [addMessage, assignedAgentId, createConversation, currentConversation, inputText, isStreaming, isSymposiumRunning, isTaskRunning, referenceImages.length, sendMessage, setError, setInputText, setReferenceImages, startExpertTask, workMode])

  const insertSymposiumMention = useCallback((participant: typeof symposiumMentionOptions[number]) => {
    if (!symposiumMention) return
    const handle = participant.handle || participant.modelName || participant.model || participant.providerName || participant.id
    const nextInput = `${inputText.slice(0, symposiumMention.start)}@${handle} ${inputText.slice(symposiumMention.cursor)}`
    const nextCaretPosition = symposiumMention.start + handle.length + 2
    setInputText(nextInput)
    setCaretPosition(nextCaretPosition)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(nextCaretPosition, nextCaretPosition)
    })
  }, [inputText, setInputText, symposiumMention, symposiumMentionOptions])

  const removeAgentMention = useCallback(() => {
    if (!agentMention) return
    const nextInput = `${inputText.slice(0, agentMention.start)}${inputText.slice(agentMention.cursor)}`.replace(/\s{2,}/g, ' ')
    setInputText(nextInput)
    setCaretPosition(agentMention.start)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(agentMention.start, agentMention.start)
    })
  }, [agentMention, inputText, setInputText])

  const setAutoRouting = useCallback(() => {
    removeAgentMention()
    setAssignedAgentId(null)
    if (currentConversation) void setConversationAgent(currentConversation.id, '__auto__')
  }, [currentConversation, removeAgentMention, setConversationAgent])

  const insertAgentMention = useCallback((agent: typeof agents[number]) => {
    if (!agentMention) return
    const nextInput = `${inputText.slice(0, agentMention.start)}${inputText.slice(agentMention.cursor)}`.replace(/\s{2,}/g, ' ')
    setInputText(nextInput)
    setAssignedAgentId(agent.id)
    if (currentConversation) void setConversationAgent(currentConversation.id, agent.id)
    setCaretPosition(agentMention.start)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(agentMention.start, agentMention.start)
    })
  }, [agentMention, currentConversation, inputText, setConversationAgent, setInputText])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (filteredSymposiumMentionOptions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveMentionIndex((index) => (index + 1) % filteredSymposiumMentionOptions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveMentionIndex((index) => (index - 1 + filteredSymposiumMentionOptions.length) % filteredSymposiumMentionOptions.length)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        insertSymposiumMention(filteredSymposiumMentionOptions[activeMentionIndex] || filteredSymposiumMentionOptions[0])
        return
      }
    }
    if (agentMention) {
      const mentionOptionCount = filteredAgentMentionOptions.length + 1
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveMentionIndex((index) => (index + 1) % mentionOptionCount)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveMentionIndex((index) => (index - 1 + mentionOptionCount) % mentionOptionCount)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        if (activeMentionIndex === 0) setAutoRouting()
        else {
          const agent = filteredAgentMentionOptions[activeMentionIndex - 1] || filteredAgentMentionOptions[0]
          if (agent) insertAgentMention(agent)
        }
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value)
    setCaretPosition(e.target.selectionStart ?? e.target.value.length)
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

  const addClipboardImages = useCallback(async (files: File[]) => {
    const slots = 4 - referenceImages.length
    if (slots <= 0) {
      setAttachmentError('You can attach up to four reference images.')
      return
    }
    const supported = files.filter((file) => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)).slice(0, slots)
    if (!supported.length) {
      setAttachmentError('Use JPG, PNG, or WebP reference images.')
      return
    }
    try {
      const saved = await Promise.all(supported.map(async (file) => {
        if (file.size > 12 * 1024 * 1024) throw new Error('Each reference image must be 12 MB or smaller.')
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read clipboard image.'))
          reader.onerror = () => reject(new Error('Could not read clipboard image.'))
          reader.readAsDataURL(file)
        })
        const stored = await window.eva.file.saveClipboardImage({ dataUrl, mediaType: file.type as ChatImageAttachment['mediaType'] })
        return { ...stored, mediaType: file.type as ChatImageAttachment['mediaType'] }
      }))
      setReferenceImages([...referenceImages, ...saved])
      setAttachmentError(null)
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Could not attach clipboard image.')
    }
  }, [referenceImages, setReferenceImages])

  const addDocumentPaths = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    const uniquePaths = paths.filter((filePath) => filePath && !documentAttachments.some((attachment) => attachment.path === filePath))
    const additions: ChatDocumentAttachment[] = []
    for (const filePath of uniquePaths.slice(0, 20 - documentAttachments.length)) {
      try {
        const entries = await window.eva.file.tree(filePath)
        const isFolder = entries.length > 0
        additions.push({ path: filePath, name: filePath.replace(/^.*[\\/]/, ''), size: 0, kind: isFolder ? 'folder' : 'file' })
      } catch {
        additions.push({ path: filePath, name: filePath.replace(/^.*[\\/]/, ''), size: 0, kind: 'file' })
      }
    }
    if (additions.length) setDocumentAttachments([...documentAttachments, ...additions])
    if (uniquePaths.length > additions.length) setAttachmentError('You can attach up to 20 files or folders at once.')
  }, [documentAttachments, setDocumentAttachments])

  const selectAttachments = () => {
    void window.eva.file.selectAttachments().then(addDocumentPaths).catch(() => setAttachmentError('Could not select attachments.'))
  }

  const handleAttachmentDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDraggingAttachments(false)
    const files = Array.from(event.dataTransfer.files)
    const images = files.filter((file) => file.type.startsWith('image/'))
    const documents = files.filter((file) => !file.type.startsWith('image/'))
    if (images.length) addReferenceFiles(images)
    void addDocumentPaths(documents.map((file) => window.eva.file.getPath(file)).filter(Boolean))
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (pastedFiles.length) {
      event.preventDefault()
      const images = pastedFiles.filter((file) => file.type.startsWith('image/'))
      const documents = pastedFiles.filter((file) => !file.type.startsWith('image/'))
      if (images.length) void addClipboardImages(images)
      void addDocumentPaths(documents.map((file) => window.eva.file.getPath(file)).filter(Boolean))
    }
  }

  const removeReferenceImage = (path: string) => {
    setReferenceImages(referenceImages.filter((image) => image.path !== path))
    setAttachmentError(null)
  }

  const removeDocumentAttachment = (path: string) => {
    setDocumentAttachments(documentAttachments.filter((attachment) => attachment.path !== path))
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

  const handleModelChoiceChange = async (choiceValue: string) => {
    const choice = modelChoices.find((item) => item.value === choiceValue)
    if (!choice) return
    await saveModelSelection(choice.providerId, choice.modelId)
  }

  const handlePermissionChange = async (permission: ConversationPermissionLevel) => {
    const conversation = currentConversation || await createConversation()
    await setConversationPermissions(conversation.id, permission, conversation.fileAccessGrants || [])
  }

  return (
    <div
      className={cn(
        'relative z-20 shrink-0 overflow-visible bg-transparent px-8 py-5',
        className,
      )}
    >
      <div className="w-full rounded-lg border border-zinc-200 bg-white shadow-[0_8px_24px_-22px_rgba(39,48,84,0.42)]">
        <div
          className={cn(
            'chat-composer relative isolate box-border min-w-0 overflow-visible rounded-xl border border-[rgba(99,102,115,0.14)] bg-transparent transition-[border-color,box-shadow,background-color] duration-200 focus-within:border-[rgba(82,86,100,0.24)]',
            isDraggingAttachments && 'border-violet-400 bg-violet-50/30',
          )}
          onDragOver={(event) => { event.preventDefault(); setIsDraggingAttachments(true) }}
          onDragLeave={() => setIsDraggingAttachments(false)}
          onDrop={handleAttachmentDrop}
        >
          <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" onChange={addReferenceImages} />
          {referenceImages.length > 0 && (
            <div className="flex flex-wrap gap-2 rounded-t-[7px] border-b border-zinc-100 bg-white px-4 py-3">
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
          {documentAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 border-b border-zinc-100 bg-[#fdfdff] px-4 py-3">
              {documentAttachments.map((attachment) => (
                <span key={attachment.path} className="inline-flex max-w-full items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700">
                  {attachment.kind === 'folder' ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-600" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-violet-600" />}
                  <span className="truncate">{attachment.name}</span>
                  <button type="button" onClick={() => removeDocumentAttachment(attachment.path)} className="-mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" title={`Remove ${attachment.name}`} aria-label={`Remove ${attachment.name}`}><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          )}
          {!isSymposiumConversation && assignedAgent && (
            <div className="flex items-center justify-between gap-3 rounded-t-[11px] border-b border-violet-100 bg-violet-50/60 px-4 py-2">
              <span className="inline-flex min-w-0 items-center gap-2 text-xs font-medium text-violet-800">
                <Bot className="h-3.5 w-3.5 shrink-0" />
                <span className="text-violet-500">Assigned agent</span>
                <span className="truncate">{assignedAgent.name}</span>
              </span>
              <button
                type="button"
                onClick={setAutoRouting}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-violet-500 transition-colors hover:bg-violet-100 hover:text-violet-800"
                title="Return to automatic agent routing"
                aria-label="Return to automatic agent routing"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
            <div className="flex min-h-16 items-end gap-3 rounded-t-[7px] bg-white px-4 py-3">
            <Button
              variant="ghost"
              size="icon"
              className="mb-0.5 h-8 w-8 shrink-0 text-zinc-400 hover:text-zinc-700"
              title="Attach files or folders. Paste a screenshot into the message box with Ctrl+V."
              aria-label="Attach files or folders; screenshots can be pasted into the message box"
              onClick={selectAttachments}
              disabled={isSymposiumRunning || isSymposiumConversation}
            >
            {referenceImages.length || documentAttachments.length ? <ImagePlus className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
            </Button>

            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onClick={(event) => setCaretPosition(event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
              onKeyUp={(event) => setCaretPosition(event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
              onPaste={handlePaste}
              placeholder={isSymposiumRunning ? 'Participants are responding to the shared discussion...' : currentConversation?.symposium ? 'Add your perspective to the shared discussion' : 'Ask Eva to write, debug, or explain code'}
              rows={1}
              disabled={isSymposiumRunning}
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
                   inputText.trim() || referenceImages.length > 0 || documentAttachments.length > 0
                    ? 'bg-violet-600 text-white hover:bg-violet-700'
                    : 'bg-zinc-100 text-zinc-400'
                )}
                onClick={handleSend}
                 disabled={isSymposiumRunning || (!inputText.trim() && referenceImages.length === 0 && documentAttachments.length === 0)}
                title={currentConversation?.symposium ? 'Send to all discussion participants' : 'Send'}
                aria-label={currentConversation?.symposium ? 'Send to all discussion participants' : 'Send message'}
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>

          {symposiumMention && !isSymposiumRunning && filteredSymposiumMentionOptions.length > 0 && (
            <div className="absolute bottom-[calc(100%+8px)] left-12 z-30 w-[min(360px,calc(100%-3rem))] overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg shadow-zinc-900/10">
              <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-zinc-400">Mention a discussion member</div>
              {filteredSymposiumMentionOptions.map((participant, index) => {
                const handle = participant.handle || participant.modelName || participant.model || participant.providerName || participant.id
                return (
                  <button
                    key={participant.id}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertSymposiumMention(participant)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
                      index === activeMentionIndex ? 'bg-violet-50 text-zinc-900' : 'text-zinc-700 hover:bg-zinc-50'
                    )}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 font-medium text-violet-700">@</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{handle}</span>
                      <span className="block truncate text-xs text-zinc-500">{participant.providerName} / {participant.modelName || participant.model}</span>
                    </span>
                  </button>
                )
              })}
              <div className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400">Arrow keys to navigate. Enter or Tab to mention.</div>
            </div>
          )}

          {agentMention && !isSymposiumRunning && (
            <div className="absolute bottom-[calc(100%+8px)] left-12 z-30 w-[min(380px,calc(100%-3rem))] overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg shadow-zinc-900/10">
              <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-zinc-400">Set the agent for this conversation</div>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={setAutoRouting}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
                  activeMentionIndex === 0 ? 'bg-violet-50 text-zinc-900' : 'text-zinc-700 hover:bg-zinc-50'
                )}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600"><Bot className="h-3.5 w-3.5" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">Auto routing</span>
                  <span className="block truncate text-xs text-zinc-500">Let Eva choose the appropriate agent for each request.</span>
                </span>
              </button>
              {filteredAgentMentionOptions.map((agent, index) => (
                <button
                  key={agent.id}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertAgentMention(agent)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
                    index + 1 === activeMentionIndex ? 'bg-violet-50 text-zinc-900' : 'text-zinc-700 hover:bg-zinc-50'
                  )}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700"><Bot className="h-3.5 w-3.5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{agent.name}</span>
                    <span className="block truncate text-xs text-zinc-500">{agent.role} · {agent.description}</span>
                  </span>
                </button>
              ))}
              <div className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400">Your selection is kept for this conversation.</div>
            </div>
          )}

          {attachmentError && <div className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{attachmentError}</div>}

          <div className="flex min-h-10 items-center justify-between gap-3 rounded-b-[7px] border-t border-zinc-100 bg-zinc-50/70 px-4 py-1.5 text-xs text-zinc-500">
            <div className="flex min-w-0 items-center gap-1.5">
              {isSymposiumConversation ? (
                <span className="inline-flex items-center gap-2 text-xs font-medium text-violet-700"><Bot className="h-3.5 w-3.5 text-violet-500" />Discussion models are fixed for this Symposium</span>
              ) : (
                <div className="w-[min(290px,34vw)] min-w-[190px]">
                  <Select
                    value={activeModelChoice}
                    onChange={(event) => void handleModelChoiceChange(event.target.value)}
                    options={modelChoiceOptions}
                    disabled={isSymposiumRunning || modelChoices.length === 0}
                    className="h-7 rounded-md border border-transparent bg-transparent px-2.5 text-xs font-medium text-zinc-600 shadow-none hover:bg-white/75 hover:text-zinc-800 focus:border-[rgba(99,102,115,0.16)] focus:bg-white/80 focus:shadow-[0_5px_14px_-12px_rgba(39,42,58,0.35)] focus:ring-0 focus-visible:border-[rgba(99,102,115,0.16)] focus-visible:ring-0"
                    menuClassName="border-[rgba(99,102,115,0.13)] bg-[#fcfcfe]/95 shadow-[0_16px_36px_-26px_rgba(39,42,58,0.38),0_5px_12px_-10px_rgba(39,42,58,0.1)]"
                    optionClassName="text-xs font-medium text-zinc-600 hover:bg-violet-50/55 hover:text-zinc-800"
                    selectedOptionClassName="bg-violet-50/75 text-xs font-medium text-zinc-800"
                    aria-label="Select model connection and model"
                    title="Select a saved connection and model"
                  />
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!isSymposiumConversation && (
                <div className="relative">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                    onClick={() => setIsConversationSettingsOpen((open) => !open)}
                    disabled={isSymposiumRunning}
                    title="Conversation settings"
                    aria-label="Conversation settings"
                    aria-expanded={isConversationSettingsOpen}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </Button>
                  {isConversationSettingsOpen && (
                    <div className="absolute bottom-[calc(100%+8px)] right-0 z-30 w-64 rounded-xl border border-[rgba(99,102,115,0.13)] bg-[#fcfcfe]/95 p-3 shadow-[0_18px_38px_-28px_rgba(39,42,58,0.4),0_6px_14px_-10px_rgba(39,42,58,0.1)] backdrop-blur-md">
                      <div className="mb-2.5">
                        <p className="text-xs font-semibold text-zinc-700">Conversation access</p>
                        <p className="mt-0.5 text-[11px] leading-4 text-zinc-500">Choose what this conversation may access.</p>
                      </div>
                      <Select
                        value={permissionLevel}
                        onChange={(event) => {
                          void handlePermissionChange(event.target.value as ConversationPermissionLevel)
                          setIsConversationSettingsOpen(false)
                        }}
                        options={[
                          { value: 'workspace', label: 'Workspace only' },
                          { value: 'granted-folders', label: 'Authorized folders' },
                          { value: 'full-access', label: 'Full filesystem access' },
                        ]}
                        className="h-8 border-[rgba(99,102,115,0.13)] bg-white/70 px-2.5 text-xs font-medium text-zinc-600 shadow-none hover:border-[rgba(99,102,115,0.2)] hover:bg-white focus-visible:border-[rgba(99,102,115,0.22)] focus-visible:shadow-[0_5px_14px_-12px_rgba(39,42,58,0.32)]"
                        menuClassName="border-[rgba(99,102,115,0.13)] bg-[#fcfcfe]/95"
                        optionClassName="text-xs font-medium text-zinc-600 hover:bg-violet-50/55 hover:text-zinc-800"
                        selectedOptionClassName="bg-violet-50/75 text-xs font-medium text-zinc-800"
                        aria-label="Conversation file permission"
                      />
                    </div>
                  )}
                </div>
              )}
              <span className="shrink-0 text-zinc-400">Shift+Enter for a new line</span>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
