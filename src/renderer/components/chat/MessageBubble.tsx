import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage, ToolCall } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { ToolCallView } from './ToolCallView'
import { User, Bot, Wrench, Copy, Check } from 'lucide-react'
import { useState } from 'react'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      aria-label="Copy code"
      className="absolute right-2 top-2 p-1 rounded bg-zinc-200/80 text-zinc-500 hover:text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity"
      title="Copy"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

export interface MessageBubbleProps {
  message: ChatMessage
  className?: string
}

export function MessageBubble({ message, className }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isTool = message.role === 'tool'

  if (isUser) {
    return (
      <article className={cn('flex justify-end', className)}>
        <div className="ml-auto flex min-h-12 max-w-[72%] items-center rounded-2xl rounded-br-sm bg-violet-600 px-5 py-3.5 text-white shadow-sm">
          {/* Agent name label */}
          {message.agentName && (
            <Badge variant="primary" className="mb-1">
              {message.agentName}
            </Badge>
          )}
          <div className="text-[15px] leading-7 whitespace-pre-wrap">{message.content}</div>
          {/* Tool calls */}
          {message.toolCalls?.map((tc: ToolCall) => (
            <ToolCallView key={tc.id} toolCall={tc} />
          ))}
        </div>
      </article>
    )
  }

  return (
    <article className={cn('flex items-start gap-3', className)}>
      {/* Avatar */}
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium',
          isTool
            ? 'bg-zinc-100 text-zinc-500'
            : 'bg-violet-100 text-violet-600'
        )}
      >
        {isTool ? <Wrench className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>

      {/* Content */}
      <div className="min-w-0 max-w-[78%]">
        {/* Agent name label */}
        {message.agentName && (
          <Badge variant="primary" className="mb-2">
            {message.agentName}
          </Badge>
        )}

        {/* Message content */}
        <div className="rounded-2xl rounded-tl-sm border border-zinc-200 bg-zinc-50 px-5 py-4 shadow-sm">
          <div className="chat-message-markdown prose prose-sm max-w-none text-zinc-900 prose-pre:bg-white prose-pre:border prose-pre:border-zinc-200 prose-code:text-zinc-800 prose-headings:text-zinc-900 prose-a:text-violet-600">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              pre({ children, ...props }) {
                return (
                  <div className="relative group">
                    <pre {...props}>{children}</pre>
                  </div>
                )
              },
              code({ children, className: codeClassName, ...props }) {
                const isInline = !codeClassName
                if (isInline) {
                  return (
                    <code className="bg-zinc-100 rounded px-1.5 py-0.5 text-xs" {...props}>
                      {children}
                    </code>
                  )
                }
                return (
                  <code className={codeClassName} {...props}>
                    {children}
                  </code>
                )
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
          </div>
        </div>

        {/* Tool calls */}
        {message.toolCalls?.map((tc: ToolCall) => (
          <ToolCallView key={tc.id} toolCall={tc} />
        ))}
      </div>
    </article>
  )
}
