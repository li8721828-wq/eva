import React from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { Bot, AlertCircle, ShieldAlert, X } from 'lucide-react'

export interface ChatPanelProps {
  className?: string
}

export function ChatPanel({ className }: ChatPanelProps) {
  const { conversations, currentConversationId, error, setError } = useChatStore()
  const { workMode } = useAppStore()
  const { getSelectedAgent } = useAgentStore()

  const agent = getSelectedAgent()
  const currentConversation = conversations.find((conversation) => conversation.id === currentConversationId)

  const modeLabels: Record<string, string> = {
    normal: 'Normal',
    expert: 'Expert Team',
    goal: 'Goal',
  }

  return (
    <div className={cn('flex flex-col h-full bg-white', className)}>
      {/* Header */}
      <div className="flex h-14 items-center justify-between border-b border-zinc-200 px-6">
        <div className="flex items-center gap-2.5">
          <Bot className="h-4 w-4 text-violet-500" />
          <span className="text-base font-medium text-zinc-800">
            {currentConversationId ? 'Conversation' : 'New Chat'}
          </span>
          <span className="text-sm text-zinc-500">{agent?.name || 'Coding Assistant'}</span>
        </div>
        <div className="flex items-center gap-2">
          {currentConversation?.accessScope === 'full' && (
            <Badge variant="warning" className="gap-1" title="This conversation can access the full local filesystem">
              <ShieldAlert className="h-3 w-3" />
              Full access
            </Badge>
          )}
          <Badge variant={workMode === 'normal' ? 'default' : 'primary'}>
            {modeLabels[workMode]}
          </Badge>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mx-4 mt-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="shrink-0 p-0.5 rounded text-red-400 hover:text-red-600 hover:bg-red-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Messages */}
      <MessageList className="flex-1" />

      {/* Input */}
      <InputBar />
    </div>
  )
}
