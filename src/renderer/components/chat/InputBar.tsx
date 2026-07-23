import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Box, Loader2, Send, Square, Paperclip } from 'lucide-react'
import type { ProviderConfigEntry, ProviderModelOption, ProviderTestConfig } from '../../../shared/types/provider'

export interface InputBarProps {
  className?: string
}

export function InputBar({ className }: InputBarProps) {
  const { isStreaming, inputText, setInputText, sendMessage, abortStream } = useChatStore()
  const { activeProviderId, activeModel, setActiveModel } = useAppStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [availableModels, setAvailableModels] = useState<ProviderModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

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

  return (
    <div className={cn('border-t border-zinc-200 bg-zinc-50/80 px-8 py-5', className)}>
      <div className="w-full">
        <div className="chat-composer overflow-hidden rounded-lg border border-zinc-300 bg-white shadow-sm transition-colors duration-200 focus-within:border-violet-500">
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
                  className="h-8 border-zinc-200 bg-white text-xs font-medium text-zinc-700"
                  aria-label="Select model"
                />
              </div>
              {loadingModels && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" />}
            </div>
            <span className="shrink-0 text-zinc-400">Shift+Enter for a new line</span>
          </div>
        </div>
      </div>
    </div>
  )
}
