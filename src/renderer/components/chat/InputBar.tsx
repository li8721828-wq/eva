import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Box, FolderOpen, FolderPlus, Loader2, Paperclip, Send, ShieldCheck, Square, Trash2 } from 'lucide-react'
import type { ConversationPermissionLevel, FileAccessGrant } from '../../../shared/types'
import type { ProviderConfigEntry, ProviderModelOption, ProviderTestConfig } from '../../../shared/types/provider'

export interface InputBarProps {
  className?: string
}

export function InputBar({ className }: InputBarProps) {
  const { conversations, createConversation, currentConversationId, isStreaming, inputText, setConversationPermissions, setInputText, sendMessage, abortStream } = useChatStore()
  const { activeProviderId, activeModel, setActiveModel } = useAppStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [availableModels, setAvailableModels] = useState<ProviderModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const currentConversation = conversations.find((conversation) => conversation.id === currentConversationId)
  const permissionLevel: ConversationPermissionLevel = currentConversation?.permissionLevel || (currentConversation?.accessScope === 'full' ? 'full-access' : 'workspace')
  const fileAccessGrants = currentConversation?.fileAccessGrants || []

  useEffect(() => {
    let cancelled = false

    const loadModels = async () => {
      setLoadingModels(true)
      try {
        const providers = (await window.eva.provider.list()) as ProviderConfigEntry[]
        const provider = providers.find((item) => item.id === activeProviderId)
        if (!provider) return

        const config: ProviderTestConfig = {
          ...provider,
          defaultModel: activeModel,
        }
        const result = await window.eva.provider.listModels(config)
        if (!cancelled && result.success) {
          setAvailableModels(result.models)
        }
      } catch (error) {
        console.error('Failed to load available models:', error)
      } finally {
        if (!cancelled) setLoadingModels(false)
      }
    }

    void loadModels()
    return () => {
      cancelled = true
    }
  }, [activeProviderId])

  const modelOptions = useMemo(() => {
    const current = { id: activeModel, name: activeModel }
    return availableModels.some((model) => model.id === activeModel)
      ? availableModels
      : [current, ...availableModels]
  }, [activeModel, availableModels])

  const handleSend = useCallback(() => {
    if (!inputText.trim() || isStreaming) return
    sendMessage()
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [inputText, isStreaming, sendMessage])

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
    abortStream()
  }

  const handleModelChange = async (model: string) => {
    if (model === activeModel) return
    setActiveModel(model)
    try {
      await window.eva.config.set('activeModel', model)
    } catch (error) {
      setActiveModel(activeModel)
      console.error('Failed to save active model:', error)
    }
  }

  const handlePermissionChange = async (permission: ConversationPermissionLevel) => {
    const conversation = currentConversation || await createConversation()
    await setConversationPermissions(conversation.id, permission, conversation.fileAccessGrants || [])
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
        <div className="chat-composer overflow-hidden rounded-lg border border-zinc-300 bg-white shadow-sm transition-colors duration-200 focus-within:border-zinc-400 focus-within:shadow-md">
          <div className="flex min-h-16 items-end gap-3 px-4 py-3">
            <Button
              variant="ghost"
              size="icon"
              className="mb-0.5 h-8 w-8 shrink-0 text-zinc-400 hover:text-zinc-700"
              title="Attach file"
              aria-label="Attach file"
            >
            <Paperclip className="h-4 w-4" />
            </Button>

            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder="Ask Eva to write, debug, or explain code"
              rows={1}
              className="chat-composer__textarea max-h-[200px] min-h-[32px] flex-1 resize-none bg-transparent py-1.5 text-sm leading-5 text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
            />

            {isStreaming ? (
              <button
                className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500 text-white transition-colors hover:bg-red-600"
                onClick={handleStop}
                title="Stop"
                aria-label="Stop generating"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                className={cn(
                  'mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
                  inputText.trim()
                    ? 'bg-violet-600 text-white hover:bg-violet-700'
                    : 'bg-zinc-100 text-zinc-400'
                )}
                onClick={handleSend}
                disabled={!inputText.trim()}
                title="Send"
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="flex min-h-11 items-center justify-between gap-4 border-t border-zinc-100 bg-zinc-50 px-4 py-2.5 text-xs text-zinc-500">
            <div className="flex min-w-0 items-center gap-2">
              <Box className="h-3.5 w-3.5 shrink-0 text-violet-500" />
              <div className="w-[220px]">
                <Select
                  value={activeModel}
                  onChange={(event) => void handleModelChange(event.target.value)}
                  options={modelOptions.map((model) => ({ value: model.id, label: model.name }))}
                  className="h-8 border-transparent bg-transparent text-xs font-medium text-zinc-700 shadow-none hover:bg-white/70 focus:border-zinc-300 focus:bg-white focus:shadow-sm focus:ring-0 focus-visible:border-zinc-300 focus-visible:ring-0"
                  aria-label="Select model"
                />
              </div>
              {loadingModels && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" />}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
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
