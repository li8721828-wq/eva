import React, { useRef, useEffect, useState, useMemo } from 'react'
import type { ChatMessage } from '../../../shared/types'
import { useChatStore } from '@/stores/use-chat-store'
import { ScrollArea } from '@/components/ui/ScrollArea'
import { MessageBubble } from './MessageBubble'
import { ToolCallView } from './ToolCallView'
import { WelcomeScreen } from './WelcomeScreen'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/use-app-store'

const PAGE_SIZE = 100

export interface MessageListProps {
  className?: string
}

export function MessageList({ className }: MessageListProps) {
  const { messages, isStreaming, streamingContent, streamingToolCalls } = useChatStore()
  const { rightPanelVisible } = useAppStore()
  const bottomRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  // Reset visible count when conversation changes (message count drops)
  useEffect(() => {
    if (messages.length < visibleCount) {
      setVisibleCount(PAGE_SIZE)
    }
  }, [messages.length])

  // Only render the most recent messages for performance
  const visibleMessages = useMemo(() => {
    if (messages.length <= visibleCount) return messages
    return messages.slice(messages.length - visibleCount)
  }, [messages, visibleCount])

  const hasMore = messages.length > visibleCount

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent, streamingToolCalls])

  if (messages.length === 0 && !isStreaming) {
    return <WelcomeScreen className={className} />
  }

  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div
        className={cn(
          'flex w-full flex-col space-y-7 px-12 py-8',
          rightPanelVisible && 'mx-auto max-w-4xl'
        )}
      >
        {/* Load more button for long conversations */}
        {hasMore && (
          <div className="flex justify-center py-2">
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-50 transition-all duration-200"
            >
              Load earlier messages ({messages.length - visibleCount} more)
            </button>
          </div>
        )}

        {visibleMessages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Streaming tool calls */}
        {isStreaming && streamingToolCalls.length > 0 && (
          <div className="px-0 py-2">
            {streamingToolCalls.map((tc) => (
              <ToolCallView key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        {/* Streaming text indicator */}
        {isStreaming && streamingContent && (
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-600 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            </div>
            <div className="max-w-[78%] rounded-2xl rounded-tl-sm border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm leading-relaxed text-zinc-700 whitespace-pre-wrap shadow-sm">
              {streamingContent}
            </div>
          </div>
        )}

        {isStreaming && !streamingContent && streamingToolCalls.length === 0 && (
          <div className="flex items-center gap-2 px-0 py-3 text-zinc-500 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Thinking...
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
