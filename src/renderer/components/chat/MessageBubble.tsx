import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage, ChatUsage } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { ToolCallGroupView } from './ToolCallView'
import { ReferenceImagePreview } from './ReferenceImagePreview'
import { Bot, Wrench, Copy, Check } from 'lucide-react'
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
      aria-label="Copy message"
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
  isStreaming?: boolean
  /** Shown only on the newest usage-bearing reply to avoid repeating totals. */
  conversationUsage?: ChatUsage
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
}

function formatCny(value: number): string {
  return value < 0.01 ? value.toFixed(4) : value.toFixed(2)
}

function UsageSummary({ usage, conversationUsage }: { usage: ChatUsage; conversationUsage?: ChatUsage }) {
  const totalTokens = usage.promptTokens + usage.completionTokens
  const cacheRate = usage.cachedTokens && usage.promptTokens > 0
    ? Math.round((usage.cachedTokens / usage.promptTokens) * 100)
    : null
  const conversationTokens = conversationUsage
    ? conversationUsage.promptTokens + conversationUsage.completionTokens
    : 0

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-zinc-200/70 pt-2.5 text-[11px] font-medium tabular-nums text-zinc-400">
      <span>
        {usage.modelCalls && usage.modelCalls > 1 ? `${usage.modelCalls} 次调用 · ` : ''}
        本次 {formatTokenCount(totalTokens)} tokens
      </span>
      <span>输入 {formatTokenCount(usage.promptTokens)} · 输出 {formatTokenCount(usage.completionTokens)}</span>
      {cacheRate !== null ? <span>缓存 {cacheRate}%</span> : null}
      {usage.estimatedCostCny !== undefined ? (
        <span title="基于 Eva 内置 DeepSeek 参考价的估算；实际账单以供应商记录为准。">
          预计 ¥{formatCny(usage.estimatedCostCny)}
        </span>
      ) : null}
      {conversationUsage && conversationTokens > totalTokens ? (
        <span className="text-zinc-350">本对话 {formatTokenCount(conversationTokens)}</span>
      ) : null}
    </div>
  )
}

export function MarkdownMessageContent({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('chat-message-markdown prose prose-sm max-w-none text-zinc-900 prose-pre:bg-white prose-pre:border prose-pre:border-zinc-200 prose-code:text-zinc-800 prose-headings:text-zinc-900 prose-a:text-violet-600', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre({ children, ...props }) {
            return <div className="relative group"><pre {...props}>{children}</pre></div>
          },
          code({ children, className: codeClassName, ...props }) {
            if (!codeClassName) {
              return <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs" {...props}>{children}</code>
            }
            return <code className={codeClassName} {...props}>{children}</code>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export function MessageBubble({ message, className, isStreaming = false, conversationUsage }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isTool = message.role === 'tool'

  if (isUser) {
    return (
      <article
        className={cn('flex justify-end', className)}
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      >
        <div className="chat-message-surface chat-user-message group relative ml-auto flex min-h-12 max-w-[72%] flex-col px-5 py-3.5 pr-12">
          {/* Agent name label */}
          {message.agentName && (
            <Badge variant="primary" className="mb-1">
              {message.agentName}
            </Badge>
          )}
          <div
            className="chat-user-message__content cursor-text select-text text-[15px] leading-7 whitespace-pre-wrap"
            style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onBeforeInput={(event) => event.preventDefault()}
            onPaste={(event) => event.preventDefault()}
            onDrop={(event) => event.preventDefault()}
            onCut={(event) => event.preventDefault()}
          >
            {message.content}
          </div>
          <CopyButton text={message.content} />
          {message.images?.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.images.map((image) => (
                <ReferenceImagePreview key={image.path} image={image} className="h-20 w-20 rounded-md border border-white/25" />
              ))}
            </div>
          ) : null}
          {/* Tool calls */}
          {message.toolCalls?.length ? <ToolCallGroupView toolCalls={message.toolCalls} className="mt-3" /> : null}
        </div>
      </article>
    )
  }

  return (
    <article className={cn('flex items-start gap-3', className)}>
      {/* Avatar */}
      <div
        aria-busy={isStreaming || undefined}
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
      <div className="min-w-0 max-w-[52rem]">
        <div className="chat-message-surface chat-assistant-message px-5 py-4">
          {message.agentName && (
            <div className="mb-2.5 flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
              <Badge variant="primary" className="px-1.5 py-0 text-[11px] leading-5">
                {message.agentName}
              </Badge>
            </div>
          )}
          <MarkdownMessageContent content={message.content} />
          {message.usage ? <UsageSummary usage={message.usage} conversationUsage={conversationUsage} /> : null}
        </div>

        {/* Tool calls */}
        {message.toolCalls?.length ? <ToolCallGroupView toolCalls={message.toolCalls} className="mt-3" /> : null}
      </div>
    </article>
  )
}
