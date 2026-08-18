import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { useTaskStore } from '@/stores/use-task-store'
import { useSymposiumStore } from '@/stores/use-symposium-store'
import { cn } from '@/lib/utils'
import { shouldUseExpertTeam } from '@/lib/team-routing'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { ReferenceImagePreview } from './ReferenceImagePreview'
import { Bot, ClipboardList, FileText, FolderOpen, Quote, Send, Settings2, Square, X } from 'lucide-react'
import type { ChatDocumentAttachment, ChatImageAttachment, ConversationPermissionLevel } from '../../../shared/types'
import type { ProviderConfigEntry } from '../../../shared/types/provider'
import { useShallow } from 'zustand/react/shallow'

export interface InputBarProps {
  className?: string
}

const SLASH_COMMANDS = [
  {
    command: 'requirement',
    label: '/requirement',
    description: '开始需求分析、代码分析、澄清与评测',
  },
  {
    command: 'requirement-modeling',
    label: '/requirement-modeling',
    description: '将已明确需求建模为标准化规格与验收文档',
  },
  {
    command: 'spec',
    label: '/spec',
    description: '基于需求建模和代码证据构建并校验实施规格',
  },
  {
    command: 'dsl',
    label: '/dsl',
    description: 'Use the completed specification to generate domain-language DSL files',
  },
  {
    command: 'coding',
    label: '/coding',
    description: 'Generate and verify isolated Java code from the persisted DSL without AI',
  },
  {
    command: 'file',
    label: '/file',
    description: '添加一个或多个文件到当前消息',
  },
  {
    command: 'folder',
    label: '/folder',
    description: '添加一个文件夹到当前消息',
  },
] as const

const COMMAND_INPUT_SEPARATOR = ' '

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
  const { conversations, createConversation, currentConversationId, inputText, quotedMessage, referenceImages, documentAttachments, setConversationPermissions, setInputText, setQuotedMessage, setReferenceImages, setDocumentAttachments, sendMessage, abortStream, addMessage, setError, startRequirementProgress, updateRequirementProgress, finishRequirementProgress } = useChatStore(useShallow((state) => ({
    conversations: state.conversations,
    createConversation: state.createConversation,
    currentConversationId: state.currentConversationId,
    inputText: state.inputText,
    quotedMessage: state.quotedMessage,
    referenceImages: state.referenceImages,
    documentAttachments: state.documentAttachments,
    setConversationPermissions: state.setConversationPermissions,
    setInputText: state.setInputText,
    setQuotedMessage: state.setQuotedMessage,
    setReferenceImages: state.setReferenceImages,
    setDocumentAttachments: state.setDocumentAttachments,
    sendMessage: state.sendMessage,
    abortStream: state.abortStream,
    addMessage: state.addMessage,
    setError: state.setError,
    startRequirementProgress: state.startRequirementProgress,
    updateRequirementProgress: state.updateRequirementProgress,
    finishRequirementProgress: state.finishRequirementProgress,
  })))
  const activeStream = useChatStore((state) => currentConversationId ? state.streamingByConversation[currentConversationId] : undefined)
  const isStreaming = Boolean(activeStream?.isStreaming)
  const { activeProviderId, activeModel, settingsOpen, setActiveProvider, setActiveModel, workMode } = useAppStore(useShallow((state) => ({
    activeProviderId: state.activeProviderId,
    activeModel: state.activeModel,
    settingsOpen: state.settingsOpen,
    setActiveProvider: state.setActiveProvider,
    setActiveModel: state.setActiveModel,
    workMode: state.workMode,
  })))
  const isTaskRunning = useTaskStore((state) => Boolean(currentConversationId && state.expertTasks[currentConversationId]?.isRunning))
  const isSymposiumRunning = useSymposiumStore((state) => Boolean(currentConversationId && state.runtimes[currentConversationId]?.status === 'running'))
  const startExpertTask = useTaskStore((state) => state.startExpertTask)
  const abortExpertTask = useTaskStore((state) => state.abortExpertTask)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isDraggingAttachments, setIsDraggingAttachments] = useState(false)
  const [savedProviders, setSavedProviders] = useState<ProviderConfigEntry[]>([])
  const [isConversationSettingsOpen, setIsConversationSettingsOpen] = useState(false)
  const [caretPosition, setCaretPosition] = useState(0)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const isRequirementSubmitting = useChatStore((state) => Boolean(
    currentConversationId && state.requirementProgressByConversation[currentConversationId]
  ))
  const currentConversation = conversations.find((conversation) => conversation.id === currentConversationId)
  const isSymposiumConversation = Boolean(currentConversation?.symposium)
  const symposiumMentionOptions = currentConversation?.symposium?.participants || []
  const permissionLevel: ConversationPermissionLevel = currentConversation?.permissionLevel || (currentConversation?.accessScope === 'full' ? 'full-access' : 'workspace')

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

  const slashCommand = useMemo(() => {
    const match = inputText.match(/^\/([a-z-]*)$/i)
    return !isSymposiumConversation && match ? match[1].toLowerCase() : null
  }, [inputText, isSymposiumConversation])

  const filteredSlashCommands = useMemo(() => {
    if (slashCommand === null) return []
    return SLASH_COMMANDS.filter((item) => item.command.startsWith(slashCommand))
  }, [slashCommand])

  const selectedSlashCommand = useMemo(() => {
    const match = inputText.match(/^\/(?:requirement(?:-modeling)?|spec|dsl|coding)(?=\s|$)/i)
    return match?.[0] || null
  }, [inputText])

  useEffect(() => {
    setActiveMentionIndex(0)
  }, [symposiumMention?.query, currentConversationId])

  useEffect(() => {
    setActiveCommandIndex(0)
  }, [slashCommand])

  useEffect(() => {
    if (!selectedSlashCommand || (inputText !== selectedSlashCommand && inputText !== `${selectedSlashCommand} `)) return
    const nextInput = `${selectedSlashCommand}${COMMAND_INPUT_SEPARATOR}`
    setInputText(nextInput)
    setCaretPosition(nextInput.length)
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(nextInput.length, nextInput.length)
    })
  }, [inputText, selectedSlashCommand, setInputText])

  useEffect(() => window.eva.requirements.onProgress((_event, progress) => updateRequirementProgress(progress)), [updateRequirementProgress])

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
    if ((!inputText.trim() && referenceImages.length === 0) || isStreaming || isTaskRunning || isSymposiumRunning || isRequirementSubmitting) return
    if (currentConversation?.symposium) {
      if (referenceImages.length > 0) {
        setError('Reference images are not supported inside Agent Symposium yet.')
        return
      }
      try {
        await window.eva.symposium.continue({ conversationId: currentConversation.id, content: inputText.trim() })
        setInputText('')
        setQuotedMessage(null)
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Could not continue the Symposium.')
      }
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }
    const codingMatch = inputText.trim().match(/^\/coding$/i)
    if (codingMatch) {
      if (referenceImages.length > 0 || documentAttachments.length > 0) {
        setError('Code generation uses the persisted DSL. Remove current attachments or images first.')
        return
      }
      let requirementConversationId: string | null = null
      try {
        const conversation = currentConversation || await createConversation()
        requirementConversationId = conversation.id
        addMessage({ id: crypto.randomUUID(), conversationId: conversation.id, role: 'user', content: '/coding', timestamp: Date.now() })
        setInputText('')
        setQuotedMessage(null)
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
        startRequirementProgress(conversation.id, 'Preparing deterministic code generation from the persisted DSL')
        await window.eva.requirements.coding({ conversationId: conversation.id })
        await useChatStore.getState().refreshConversation(conversation.id)
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Deterministic code generation failed.')
      } finally {
        if (requirementConversationId) finishRequirementProgress(requirementConversationId)
      }
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }
    const dslMatch = inputText.trim().match(/^\/dsl$/i)
    if (dslMatch) {
      if (referenceImages.length > 0 || documentAttachments.length > 0) {
        setError('DSL generation uses the completed specification. Remove current attachments or images first.')
        return
      }
      let requirementConversationId: string | null = null
      try {
        const conversation = currentConversation || await createConversation()
        requirementConversationId = conversation.id
        addMessage({ id: crypto.randomUUID(), conversationId: conversation.id, role: 'user', content: '/dsl', timestamp: Date.now() })
        setInputText('')
        setQuotedMessage(null)
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
        startRequirementProgress(conversation.id, '正在读取已完成的最终实施规格')
        await window.eva.requirements.dsl({ conversationId: conversation.id })
        await useChatStore.getState().refreshConversation(conversation.id)
      } catch (error) {
        setError(error instanceof Error ? error.message : 'DSL generation failed.')
      } finally {
        if (requirementConversationId) finishRequirementProgress(requirementConversationId)
      }
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }
    const specificationMatch = inputText.trim().match(/^\/spec$/i)
    if (specificationMatch) {
      if (referenceImages.length > 0 || documentAttachments.length > 0) {
        setError('规格构建使用已完成的需求建模和代码证据，请先移除当前附件或图片。')
        return
      }
      let requirementConversationId: string | null = null
      try {
        const conversation = currentConversation || await createConversation()
        requirementConversationId = conversation.id
        addMessage({ id: crypto.randomUUID(), conversationId: conversation.id, role: 'user', content: '/spec', timestamp: Date.now() })
        setInputText('')
        setQuotedMessage(null)
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
        startRequirementProgress(conversation.id, '正在读取需求建模成果并核对代码证据')
        await window.eva.requirements.spec({ conversationId: conversation.id })
        await useChatStore.getState().refreshConversation(conversation.id)
      } catch (error) {
        setError(error instanceof Error ? error.message : '规格构建执行失败。')
      } finally {
        if (requirementConversationId) finishRequirementProgress(requirementConversationId)
      }
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }
    const requirementModelingMatch = inputText.trim().match(/^\/requirement-modeling$/i)
    if (requirementModelingMatch) {
      if (referenceImages.length > 0 || documentAttachments.length > 0) {
        setError('需求建模直接使用已确认的最终需求，请先移除当前附件或图片。')
        return
      }
      let requirementConversationId: string | null = null
      try {
        const conversation = currentConversation || await createConversation()
        requirementConversationId = conversation.id
        addMessage({
          id: crypto.randomUUID(),
          conversationId: conversation.id,
          role: 'user',
          content: '/requirement-modeling',
          timestamp: Date.now(),
        })
        setInputText('')
        setQuotedMessage(null)
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
        startRequirementProgress(conversation.id, '正在读取已确认需求并选择建模标准')
        await window.eva.requirements.model({ conversationId: conversation.id })
        await useChatStore.getState().refreshConversation(conversation.id)
      } catch (error) {
        setError(error instanceof Error ? error.message : '需求建模执行失败。')
      } finally {
        if (requirementConversationId) finishRequirementProgress(requirementConversationId)
      }
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }
    const requirementMatch = inputText.trim().match(/^\/requirement(?:\s+([\s\S]*))?$/i)
    if (requirementMatch) {
      if (referenceImages.length > 0) {
        setError('需求工程暂不直接接收图片，请先用普通对话描述图片内容或附加需求文档。')
        return
      }
      let requirementConversationId: string | null = null
      try {
        const conversation = currentConversation || await createConversation()
        requirementConversationId = conversation.id
        addMessage({
          id: crypto.randomUUID(),
          conversationId: conversation.id,
          role: 'user',
          content: inputText.trim(),
          attachments: documentAttachments,
          timestamp: Date.now(),
        })
        setInputText('')
        setQuotedMessage(null)
        setDocumentAttachments([])
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
        startRequirementProgress(conversation.id, '正在读取需求输入和附件')
        await window.eva.requirements.submit({
          conversationId: conversation.id,
          content: requirementMatch[1]?.trim(),
          attachments: documentAttachments,
        })
        await useChatStore.getState().refreshConversation(conversation.id)
      } catch (error) {
        setError(error instanceof Error ? error.message : '需求工程执行失败。')
      } finally {
        if (requirementConversationId) finishRequirementProgress(requirementConversationId)
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
      setQuotedMessage(null)
      setReferenceImages([])
      await startExpertTask(goal, conversation.id)
    } else {
      await sendMessage()
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [addMessage, createConversation, currentConversation, currentConversationId, documentAttachments, finishRequirementProgress, inputText, isRequirementSubmitting, isStreaming, isSymposiumRunning, isTaskRunning, referenceImages.length, sendMessage, setDocumentAttachments, setError, setInputText, setQuotedMessage, setReferenceImages, startExpertTask, startRequirementProgress, workMode])

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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveCommandIndex((index) => (index + 1) % filteredSlashCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveCommandIndex((index) => (index - 1 + filteredSlashCommands.length) % filteredSlashCommands.length)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        insertSlashCommand((filteredSlashCommands[activeCommandIndex] || filteredSlashCommands[0]).command)
        return
      }
    }
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
    if (isRequirementSubmitting && currentConversationId) {
      void window.eva.requirements.abort(currentConversationId)
      return
    }
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

  const insertSlashCommand = useCallback((command: typeof SLASH_COMMANDS[number]['command']) => {
    if (command === 'file' || command === 'folder') {
      setInputText('')
      setCaretPosition(0)
      requestAnimationFrame(() => textareaRef.current?.focus())
      const selection = command === 'file'
        ? window.eva.file.selectFiles()
        : window.eva.file.selectFolder().then((path) => path ? [path] : [])
      void selection.then(addDocumentPaths).catch(() => setAttachmentError('Could not select attachments.'))
      return
    }
    const nextInput = `/${command}${COMMAND_INPUT_SEPARATOR}`
    setInputText(nextInput)
    setCaretPosition(nextInput.length)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(nextInput.length, nextInput.length)
    })
  }, [addDocumentPaths, setInputText])

  const handleAttachmentDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDraggingAttachments(false)
    const workspacePath = event.dataTransfer.getData('application/x-eva-workspace-path')
    if (workspacePath) {
      void addDocumentPaths([workspacePath])
      return
    }
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
      <div className="w-full">
        <div
          className={cn(
            'chat-composer relative box-border min-w-0 overflow-visible rounded-lg border border-transparent bg-white shadow-[0_0_30px_-10px_rgba(53,62,104,0.22),0_0_12px_-4px_rgba(53,62,104,0.12),inset_0_1px_0_rgba(255,255,255,0.96)] transition-[border-color,box-shadow,background-color] duration-200 focus-within:border-violet-100 focus-within:shadow-[0_0_34px_-9px_rgba(109,83,190,0.28),0_0_14px_-4px_rgba(53,62,104,0.14),inset_0_1px_0_rgba(255,255,255,0.98)]',
            isDraggingAttachments && 'border-violet-200 bg-violet-50/40 shadow-[0_0_34px_-9px_rgba(109,83,190,0.28),0_0_14px_-4px_rgba(53,62,104,0.14),inset_0_1px_0_rgba(255,255,255,0.98)]',
          )}
          onDragOver={(event) => { event.preventDefault(); setIsDraggingAttachments(true) }}
          onDragLeave={() => setIsDraggingAttachments(false)}
          onDrop={handleAttachmentDrop}
        >
          {quotedMessage && (
            <div className="flex min-w-0 items-start gap-2.5 rounded-t-[7px] border-b border-violet-100 bg-violet-50/55 px-4 py-2.5">
              <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold text-violet-700">
                  {quotedMessage.role === 'user' ? '引用用户消息' : '引用助手消息'}
                  {quotedMessage.authorName ? ` · ${quotedMessage.authorName}` : ''}
                </div>
                <div className="mt-0.5 truncate text-xs text-zinc-600">
                  {quotedMessage.content.replace(/\s+/g, ' ').trim() || '(空消息)'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setQuotedMessage(null)}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-white/80 hover:text-zinc-700"
                title="取消引用"
                aria-label="取消引用"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
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
            <div className="flex flex-wrap gap-2 rounded-t-[7px] border-b border-zinc-100 bg-white px-4 py-3">
              {documentAttachments.map((attachment) => (
                <span key={attachment.path} className="inline-flex max-w-full items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700">
                  {attachment.kind === 'folder' ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-600" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-violet-600" />}
                  <span className="truncate">{attachment.name}</span>
                  <button type="button" onClick={() => removeDocumentAttachment(attachment.path)} className="-mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" title={`Remove ${attachment.name}`} aria-label={`Remove ${attachment.name}`}><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          )}
            <div className="flex min-h-16 items-end gap-3 rounded-t-[7px] bg-white px-4 py-3">
            <div className="relative min-h-[32px] flex-1">
              {selectedSlashCommand && (
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words py-1.5 text-sm leading-5 text-zinc-900">
                  <span className="font-medium text-violet-600">{selectedSlashCommand}</span>
                  {inputText.slice(selectedSlashCommand.length)}
                </div>
              )}
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
                disabled={isSymposiumRunning || isRequirementSubmitting}
                className={cn(
                  'chat-composer__textarea relative z-10 max-h-[200px] min-h-[32px] w-full resize-none bg-transparent py-1.5 text-base leading-5 placeholder:text-zinc-400 focus:outline-none',
                  selectedSlashCommand ? 'text-transparent caret-zinc-900 selection:bg-violet-200 selection:text-transparent' : 'text-zinc-900',
                )}
              />
            </div>

            {isStreaming || isTaskRunning || isRequirementSubmitting ? (
              <button
                className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500 text-white transition-colors hover:bg-red-600"
                onClick={handleStop}
                title={isRequirementSubmitting ? '停止需求工程' : isTaskRunning ? 'Stop team' : 'Stop'}
                aria-label={isRequirementSubmitting ? '停止需求工程' : isTaskRunning ? 'Stop team' : 'Stop generating'}
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                className={cn(
                  'mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
                   !isRequirementSubmitting && (inputText.trim() || referenceImages.length > 0 || documentAttachments.length > 0)
                    ? 'bg-violet-600 text-white hover:bg-violet-700'
                    : 'bg-zinc-100 text-zinc-400'
                )}
                onClick={handleSend}
                 disabled={isSymposiumRunning || isRequirementSubmitting || (!inputText.trim() && referenceImages.length === 0 && documentAttachments.length === 0)}
                title={isRequirementSubmitting ? '需求工程正在执行' : currentConversation?.symposium ? 'Send to all discussion participants' : 'Send'}
                aria-label={isRequirementSubmitting ? '需求工程正在执行' : currentConversation?.symposium ? 'Send to all discussion participants' : 'Send message'}
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>

          {filteredSlashCommands.length > 0 && !isSymposiumRunning && (
            <div className="absolute bottom-[calc(100%+8px)] left-12 z-30 w-[min(440px,calc(100%-3rem))] overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg shadow-zinc-900/10">
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] font-medium text-zinc-500">
                <ClipboardList className="h-3.5 w-3.5 text-violet-500" />
                对话命令
              </div>
              {filteredSlashCommands.map((item, index) => (
                <button
                  key={item.command}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertSlashCommand(item.command)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
                    index === activeCommandIndex ? 'bg-violet-50 text-zinc-900' : 'text-zinc-700 hover:bg-zinc-50',
                  )}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-100 text-violet-700"><ClipboardList className="h-3.5 w-3.5" /></span>
                  <span className="min-w-0 flex-1"><span className="block font-mono text-sm font-medium">{item.label}</span><span className="block truncate text-xs text-zinc-500">{item.description}</span></span>
                  <span className="shrink-0 text-[11px] text-zinc-400">Enter</span>
                </button>
              ))}
              <div className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400">方向键选择，Enter 或 Tab 填入命令。</div>
            </div>
          )}

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

          {/* Per-conversation agent switching is intentionally hidden for now.
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
          */}

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
