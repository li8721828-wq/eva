import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'streamdown/styles.css'
import type { AgentMarkdownRenderer, AgentOutputColor, AgentOutputFont, AgentOutputFontSize, AgentOutputFormat, AgentOutputStyle, AgentOutputTextEffect, ChatMessage, ChatUsage } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { ToolCallGroupView } from './ToolCallView'
import { ReferenceImagePreview } from './ReferenceImagePreview'
import { Bot, Wrench, Copy, Check, Heart, Quote, ChevronDown, BrainCircuit, CircleAlert, ExternalLink, SearchCheck } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { normalizeChatMarkdown } from '@/lib/markdown-display'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label="Copy message"
      className={cn(
        'mt-1 mr-1 inline-flex h-6 w-6 self-end items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-100',
        copied
          ? 'text-[#91acd7] opacity-100'
          : 'text-[#a9bee2] opacity-0 group-hover:opacity-100 hover:text-[#91acd7] focus-visible:opacity-100 focus-visible:text-[#91acd7]',
      )}
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
    <div className="chat-usage-summary mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-2.5 text-[11px] font-medium tabular-nums text-zinc-400">
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

function ReasoningPanel({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const [open, setOpen] = useState(streaming)
  if (!content) return null

  return (
    <details open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)} className="mb-3 border-y border-violet-100 bg-violet-50/45">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-violet-700 hover:bg-violet-50/80">
        <BrainCircuit className="h-3.5 w-3.5" />
        <span className="flex-1">模型思考{streaming ? '中' : ''}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </summary>
      <div className="max-h-56 overflow-auto border-t border-violet-100 px-3 py-2.5 text-xs leading-5 text-zinc-600 whitespace-pre-wrap">{content}</div>
    </details>
  )
}

function markdownNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(markdownNodeText).join('')
  if (React.isValidElement<{ children?: ReactNode }>(node)) return markdownNodeText(node.props.children)
  return ''
}

function MarkdownCodeBlock({ children, language }: { children: ReactNode; language?: string }) {
  const [copied, setCopied] = useState(false)
  const code = markdownNodeText(children).replace(/\n$/, '')

  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="markdown-code-block group">
      <div className="markdown-code-block__bar">
        <span>{language || 'text'}</span>
        <button type="button" onClick={() => void copy()} title="Copy code" aria-label="Copy code">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

const progressPresentation = {
  thinking: { icon: BrainCircuit, tone: 'text-zinc-600', iconTone: 'bg-violet-100 text-violet-600' },
  finding: { icon: SearchCheck, tone: 'text-zinc-600', iconTone: 'bg-sky-100 text-sky-600' },
  action: { icon: Wrench, tone: 'text-zinc-600', iconTone: 'bg-emerald-100 text-emerald-600' },
  issue: { icon: CircleAlert, tone: 'text-rose-700', iconTone: 'bg-rose-100 text-rose-600' },
} as const

function ProgressUpdateMessage({ message }: { message: ChatMessage }) {
  const presentation = progressPresentation[message.progressKind!]
  const Icon = presentation.icon
  return (
    <article className="flex max-w-[46rem] items-start gap-2.5 py-2" aria-label="Eva 工作进展">
      <span className={cn('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full', presentation.iconTone)}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 pt-0.5">
        <MarkdownMessageContent content={message.content} className={cn('text-[13px] leading-6', presentation.tone)} />
      </div>
    </article>
  )
}

function StreamdownLink({ children, href, node: _node, ...props }: React.ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  return <a href={href} target="_blank" rel="noreferrer noopener" {...props}>{children}<ExternalLink aria-hidden="true" className="markdown-external-link" /></a>
}

const streamdownComponents = { a: StreamdownLink }

const StreamdownRenderer = React.lazy(async () => {
  const { Streamdown } = await import('streamdown')
  return { default: Streamdown }
})

function safeStreamdownUrl(url: string): string {
  const normalized = url.trim()
  return /^(https?:|mailto:)/i.test(normalized) || normalized.startsWith('/') || normalized.startsWith('#')
    ? normalized
    : ''
}

export function MarkdownMessageContent({ content, className, isStreaming = false, outputFormat = 'default', outputStyle = 'balanced', outputFont = 'system', outputColor = 'slate', outputFontSize = 'medium', outputTextEffect = 'none', markdownRenderer = 'enhanced' }: { content: string; className?: string; isStreaming?: boolean; outputFormat?: AgentOutputFormat; outputStyle?: AgentOutputStyle; outputFont?: AgentOutputFont; outputColor?: AgentOutputColor; outputFontSize?: AgentOutputFontSize; outputTextEffect?: AgentOutputTextEffect; markdownRenderer?: AgentMarkdownRenderer }) {
  const markdownContent = normalizeChatMarkdown(content)
  const markdownClassName = cn('chat-message-markdown prose prose-sm max-w-none', `chat-message-markdown--format-${outputFormat}`, `chat-message-markdown--${outputStyle}`, `chat-message-markdown--font-${outputFont}`, `chat-message-markdown--color-${outputColor}`, `chat-message-markdown--font-size-${outputFontSize}`, `chat-message-markdown--effect-${outputTextEffect}`, `chat-message-markdown--renderer-${markdownRenderer}`, className)

  if (markdownRenderer === 'streamdown') {
    return (
      <div className={markdownClassName}>
        <React.Suspense fallback={<div className="whitespace-pre-wrap">{markdownContent}</div>}>
          <StreamdownRenderer
            mode={isStreaming ? "streaming" : "static"}
            isAnimating={isStreaming}
            animated={false}
            parseIncompleteMarkdown
            skipHtml
            urlTransform={safeStreamdownUrl}
            controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
            components={streamdownComponents}
            className="streamdown-message-content"
          >
            {markdownContent}
          </StreamdownRenderer>
        </React.Suspense>
      </div>
    )
  }

  return (
    <div className={markdownClassName}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={isStreaming ? [] : [rehypeHighlight]}
        components={{
          pre({ children }) {
            const codeElement = React.Children.toArray(children).find(React.isValidElement)
            const codeClassName = React.isValidElement<{ className?: string }>(codeElement) ? codeElement.props.className : undefined
            const language = codeClassName?.match(/language-([^\s]+)/)?.[1]
            return <MarkdownCodeBlock language={language}>{children}</MarkdownCodeBlock>
          },
          code({ children, className: codeClassName, ...props }) {
            if (!codeClassName) {
              return <code className="markdown-inline-code" {...props}>{children}</code>
            }
            return <code className={codeClassName} {...props}>{children}</code>
          },
          a({ href, children, ...props }) {
            return <a href={href} target="_blank" rel="noreferrer noopener" {...props}>{children}<ExternalLink aria-hidden="true" className="markdown-external-link" /></a>
          },
          table({ children }) {
            return <div className="markdown-table-wrap"><table>{children}</table></div>
          },
          ul({ children }) {
            return <ul className="markdown-list markdown-list--unordered">{children}</ul>
          },
          ol({ children }) {
            return <ol className="markdown-list markdown-list--ordered">{children}</ol>
          },
          li({ children }) {
            return <li className="markdown-list-item">{children}</li>
          },
        }}
      >
        {markdownContent}
      </ReactMarkdown>
    </div>
  )
}

export const MessageBubble = React.memo(function MessageBubble({ message, className, isStreaming = false, conversationUsage }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isTool = message.role === 'tool'
  const language = useAppStore((state) => state.language)
  const agents = useAgentStore((state) => state.agents)
  const updateMessageFavorite = useChatStore((state) => state.updateMessageFavorite)
  const setQuotedMessage = useChatStore((state) => state.setQuotedMessage)
  const [copied, setCopied] = useState(false)
  const actionCopy = language === 'zh'
    ? { copy: '复制', copied: '已复制', favorite: '收藏', unfavorite: '取消收藏', regenerate: '重新生成', remove: '删除回复', confirm: '删除这条回复及其后续内容吗？' }
    : language === 'ja'
      ? { copy: 'コピー', copied: 'コピー済み', favorite: 'お気に入り', unfavorite: 'お気に入りを解除', regenerate: '再生成', remove: '返信を削除', confirm: 'この返信と後続の内容を削除しますか？' }
      : { copy: 'Copy', copied: 'Copied', favorite: 'Favorite', unfavorite: 'Unfavorite', regenerate: 'Regenerate', remove: 'Delete reply', confirm: 'Delete this reply and everything after it?' }

  const handleCopyAssistant = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const quoteCurrentMessage = () => {
    if (message.role !== 'user' && message.role !== 'assistant') return
    setQuotedMessage({
      messageId: message.id,
      role: message.role,
      content: message.content.slice(0, 16_000),
      authorName: message.agentName,
    })
  }

  const outputAgent = message.agentId
    ? agents.find((agent) => agent.id === message.agentId)
    : undefined
  const shouldShowReasoning = isStreaming || Boolean(outputAgent?.showThinking)
  const outputStyle = outputAgent?.outputStyle || 'balanced'
  const outputFormat = outputAgent?.outputFormat || 'default'
  const outputFont = outputAgent?.outputFont || 'system'
  const outputColor = outputAgent?.outputColor || 'slate'
  const outputFontSize = outputAgent?.outputFontSize || 'medium'
  const outputTextEffect = outputAgent?.outputTextEffect || 'none'
  const markdownRenderer = outputAgent?.markdownRenderer || 'enhanced'

  if (message.progressKind) return <ProgressUpdateMessage message={message} />

  if (isUser) {
    return (
      <article
        className={cn('flex justify-end', className)}
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      >
        <div className="group ml-auto flex max-w-[72%] flex-col items-end">
          <div className="chat-message-surface chat-user-message flex min-h-16 max-w-full flex-col px-6 py-4">
            {/* Agent name label */}
            {message.agentName && (
              <Badge variant="primary" className="mb-1">
                {message.agentName}
              </Badge>
            )}
            <div
              className="chat-user-message__content cursor-text select-text whitespace-pre-wrap"
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
            {message.quotedMessage ? (
              <div className="mt-3 flex max-w-full items-start gap-2 border-l-2 border-[#cdddf1] bg-white/45 px-3 py-2 text-left text-xs leading-5 text-[#59718f]">
                <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8da7cc]" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="font-medium text-[#7189aa]">引用{message.quotedMessage.role === 'assistant' ? '助手' : '用户'}消息</div>
                  <div className="truncate">{message.quotedMessage.content}</div>
                </div>
              </div>
            ) : null}
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
          <div className="message-actions mt-1 flex items-center gap-0.5 self-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button type="button" onClick={quoteCurrentMessage} className="message-action inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-400 transition-colors" title="引用消息" aria-label="引用消息">
              <Quote className="h-3.5 w-3.5" />引用
            </button>
            <CopyButton text={message.content} />
          </div>
        </div>
      </article>
    )
  }

  return (
    <article className={cn('group flex items-start gap-3', className)}>
      {/* Avatar */}
      <div
        aria-busy={isStreaming || undefined}
        className={cn(
          'chat-message-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium',
          isTool
            ? 'bg-zinc-100 text-zinc-500'
            : 'bg-violet-100 text-violet-600'
        )}
      >
        {isTool ? <Wrench className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>

      {/* Content */}
      <div className="min-w-0 max-w-[66rem]">
        <div className={cn('chat-message-surface chat-assistant-message py-4 pl-3 pr-5', `chat-assistant-message--format-${outputFormat}`)}>
          {message.agentName && (
            <div className="chat-agent-label mb-2.5 flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
              <Badge variant="primary" className="px-1.5 py-0 text-[11px] leading-5">
                {message.agentName}
              </Badge>
            </div>
          )}
          {shouldShowReasoning && <ReasoningPanel content={message.reasoningContent || ''} streaming={isStreaming} />}
          <MarkdownMessageContent content={message.content} isStreaming={isStreaming} outputFormat={outputFormat} outputStyle={outputStyle} outputFont={outputFont} outputColor={outputColor} outputFontSize={outputFontSize} outputTextEffect={outputTextEffect} markdownRenderer={markdownRenderer} />
          {message.usage ? <UsageSummary usage={message.usage} conversationUsage={conversationUsage} /> : null}
        </div>

        {!isStreaming && !isTool && (
          <div className="message-actions mt-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button type="button" onClick={quoteCurrentMessage} className="message-action inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-400 transition-colors" title="引用消息" aria-label="引用消息">
              <Quote className="h-3.5 w-3.5" />引用
            </button>
            <button type="button" onClick={() => void handleCopyAssistant()} className="message-action inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-400 transition-colors" title={actionCopy.copy} aria-label={actionCopy.copy}>
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}{copied ? actionCopy.copied : actionCopy.copy}
            </button>
            <button type="button" onClick={() => void updateMessageFavorite(message.id, !message.favorited)} className={cn('message-action inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors', message.favorited ? 'text-violet-600' : 'text-zinc-400')} title={message.favorited ? actionCopy.unfavorite : actionCopy.favorite} aria-label={message.favorited ? actionCopy.unfavorite : actionCopy.favorite}>
              <Heart className={cn('h-3.5 w-3.5', message.favorited && 'fill-current')} />{message.favorited ? actionCopy.unfavorite : actionCopy.favorite}
            </button>
          </div>
        )}

        {message.toolCalls?.length ? (
          <details className="mt-3 border-t border-zinc-100 pt-2">
            <summary className="cursor-pointer text-xs font-medium text-zinc-400 hover:text-zinc-600">技术执行明细（{message.toolCalls.length} 项）</summary>
            <ToolCallGroupView toolCalls={message.toolCalls} className="mt-2" />
          </details>
        ) : null}
      </div>
    </article>
  )
})
