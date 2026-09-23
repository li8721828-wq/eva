import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'streamdown/styles.css'
import type { AgentMarkdownRenderer, AgentOutputColor, AgentOutputFont, AgentOutputFontSize, AgentOutputFormat, AgentOutputStyle, AgentOutputTextEffect, ChatMessage, ChatUsage, ExecutionTimelineEntry, ResponseTiming, ToolCall } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { ToolCallGroupView, ToolCallView } from './ToolCallView'
import { PlanChecklist } from './PlanChecklist'
import { ReferenceImagePreview } from './ReferenceImagePreview'
import { Bot, Wrench, Copy, Check, Heart, Quote, ChevronDown, BrainCircuit, ExternalLink, Loader2, FileText, FileSpreadsheet, FolderOpen, CheckCircle2, XCircle, Info, CircleDot, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { normalizeChatMarkdown, normalizeStreamingMarkdown } from '@/lib/markdown-display'
import { isFilePathLikeCodeSpan } from '@/lib/file-path-chip'
import { buildProcessFeed, isInternalToolLifecycleUpdate, isStructuredReport, processReportLabel, type ProcessFeed, type ProcessReportEntry } from '@/lib/process-report'
import { FilePathChip } from './FilePathChip'

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
  /**
   * Whether the quote/copy/favorite row is offered. The live copy turns it off:
   * its id is synthetic, so these actions would address no stored row.
   */
  showActions?: boolean
  /** True only for the newest persisted reply, which is the one that may re-run its round. */
  canRegenerate?: boolean
  /** Shown only on the newest usage-bearing reply to avoid repeating totals. */
  conversationUsage?: ChatUsage
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value)
}

function formatCny(value: number): string {
  return value < 0.01 ? value.toFixed(4) : value.toFixed(2)
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.max(0, Math.round(value))} ms`
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} s`
}

function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function MessageAttachments({ attachments }: { attachments: NonNullable<ChatMessage['attachments']> }) {
  if (attachments.length === 0) return null
  return (
    <div className="chat-message-attachments mt-3 mb-1 flex min-w-0 flex-wrap gap-2" aria-label="消息中的文件">
      {attachments.map((attachment) => {
        const isSpreadsheet = /\.(xlsx|xls|ods)$/iu.test(attachment.name)
        const Icon = attachment.kind === 'folder' ? FolderOpen : isSpreadsheet ? FileSpreadsheet : FileText
        const size = formatAttachmentSize(attachment.size)
        return (
          <div
            key={attachment.path}
            className="chat-message-attachment inline-flex min-w-0 max-w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left"
            title={attachment.path}
          >
            <span className="chat-message-attachment__icon flex h-7 w-7 shrink-0 items-center justify-center rounded-md" aria-hidden="true">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 max-w-[min(20rem,calc(100vw-11rem))]">
              <span className="block truncate text-xs font-medium">{attachment.name}</span>
              <span className="mt-0.5 flex items-center gap-1 text-xs">
                {size ? <span>{size}</span> : null}
                {size ? <span aria-hidden="true">·</span> : null}
                <span>已加入消息</span>
              </span>
            </span>
            <CheckCircle2 className="chat-message-attachment__status h-3.5 w-3.5 shrink-0" aria-label="文件已加入消息" />
          </div>
        )
      })}
    </div>
  )
}

function formatSupplierCost(value: number, currency?: string): string {
  const normalizedCurrency = currency?.trim().toUpperCase()
  if (!normalizedCurrency) return value < 0.01 ? value.toFixed(4) : value.toFixed(2)
  if (normalizedCurrency === 'CNY') return `¥${formatCny(value)}`
  if (normalizedCurrency === 'USD') return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
  return `${normalizedCurrency} ${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
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
    <div className="mt-4 pt-2.5">
      <div className="chat-usage-summary flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs tabular-nums text-zinc-400">
        <span>
          {usage.modelCalls && usage.modelCalls > 1 ? `${usage.modelCalls} 次调用 · ` : ''}
          本次 {formatTokenCount(totalTokens)} tokens
        </span>
        <span>输入 {formatTokenCount(usage.promptTokens)} · 输出 {formatTokenCount(usage.completionTokens)}</span>
        {cacheRate !== null ? <span>缓存 {cacheRate}%</span> : null}
        {usage.providerReportedCost !== undefined ? (
          <span title={usage.providerReportedCurrency ? '由供应商响应返回的本次实际费用。' : '供应商响应返回了金额，但未声明币种，未纳入人民币汇总。'}>
            {usage.providerReportedCurrency ? '费用' : '供应商金额'} {formatSupplierCost(usage.providerReportedCost, usage.providerReportedCurrency)}
          </span>
        ) : usage.estimatedCostCny !== undefined ? (
          <span title="按此连接保存的模型价格卡计算；实际账单以供应商记录为准。">
            预计 ¥{formatCny(usage.estimatedCostCny)}
          </span>
        ) : usage.estimatedCost !== undefined ? (
          <span title={usage.pricingSourceUrl ? `按该供应商官网同步的费率计算：${usage.pricingSourceUrl}` : '按此连接保存的模型价格卡计算；实际账单以供应商记录为准。'}>
            预计 {formatSupplierCost(usage.estimatedCost, usage.estimatedCostCurrency)}
          </span>
        ) : usage.pricingMode === 'subscription' ? (
          <span title={usage.pricingSourceUrl ? `该连接为订阅额度制：${usage.pricingSourceUrl}` : '该连接为订阅额度制，无法按本次 Token 计算单独费用。'}>订阅额度制</span>
        ) : null}
        {conversationUsage && conversationTokens > totalTokens ? (
          <span className="text-zinc-350">本对话 {formatTokenCount(conversationTokens)}</span>
        ) : null}
      </div>
    </div>
  )
}

function TimingSummary({ timing }: { timing: ResponseTiming }) {
  const detail = [
    `总耗时 ${formatDuration(timing.totalMs)}`,
    timing.localPreparationMs !== undefined ? `本地准备 ${formatDuration(timing.localPreparationMs)}` : '',
    timing.contextBuildMs !== undefined ? `上下文 ${formatDuration(timing.contextBuildMs)}` : '',
    timing.timeToFirstResponseMs !== undefined ? `首响应 ${formatDuration(timing.timeToFirstResponseMs)}` : '',
    `模型 ${formatDuration(timing.modelDurationMs)}`,
    timing.toolCalls?.length ? `工具 ${formatDuration(timing.toolExecutionMs)} (${timing.toolCalls.length})` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-zinc-400" title={detail}>
      <span>总耗时 {formatDuration(timing.totalMs)}</span>
      {timing.timeToFirstResponseMs !== undefined ? <span>首响应 {formatDuration(timing.timeToFirstResponseMs)}</span> : null}
      <span>模型 {formatDuration(timing.modelDurationMs)}</span>
      {timing.toolCalls?.length ? <span>工具 {formatDuration(timing.toolExecutionMs)} · {timing.toolCalls.length} 次</span> : null}
    </div>
  )
}

function ReasoningPanel({ content, streaming = false }: { content: string; streaming?: boolean }) {
  // Raw chain-of-thought is a technical detail, never the headline: it starts
  // folded, keeps a muted treatment, and sits after the work report.
  const [open, setOpen] = useState(false)
  if (!content) return null

  return (
    <details open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)} className="group mt-1.5 border-t border-zinc-100 pt-1">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-xs font-normal text-zinc-400 hover:bg-zinc-50/70 hover:text-zinc-500">
        <BrainCircuit className="h-3.5 w-3.5" />
        <span className="flex-1">模型原始思考{streaming ? '中' : ''}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </summary>
      <div className="max-h-56 overflow-auto px-2 py-2 text-xs leading-5 text-zinc-500 whitespace-pre-wrap">{content}</div>
    </details>
  )
}

interface TimelineEntryGroup {
  kind: ExecutionTimelineEntry['kind']
  entries: ExecutionTimelineEntry[]
}

function groupTimelineEntries(entries: ExecutionTimelineEntry[]): TimelineEntryGroup[] {
  const groups: TimelineEntryGroup[] = []
  for (const entry of entries) {
    const last = groups[groups.length - 1]
    if (last?.kind === entry.kind) last.entries.push(entry)
    else groups.push({ kind: entry.kind, entries: [entry] })
  }
  return groups
}

function TimelineToolGroup({ entries, streaming = false }: { entries: ExecutionTimelineEntry[]; streaming?: boolean }) {
  // A running step is exactly what the user is watching for, so its rows start
  // expanded and fall back to the summary once the round is done. Tool activity
  // is background material though: it stays deliberately quieter than the work
  // report above it.
  const [open, setOpen] = useState(streaming)
  const toolCalls = entries.flatMap((entry) => entry.toolCall ? [entry.toolCall] : [])
  if (toolCalls.length === 0) return null
  const isRunning = toolCalls.some((toolCall) => !toolCall.result && !toolCall.isError)
  const hasError = toolCalls.some((toolCall) => toolCall.isError)
  const singleLabel = toolCalls.length === 1 ? executionToolActivityLabel(toolCalls[0]) : undefined

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-normal text-zinc-500 transition-colors hover:bg-zinc-50"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-zinc-300 transition-transform', open && 'rotate-180')} />
        <Wrench className="h-3.5 w-3.5 shrink-0 text-zinc-300" />
        <span className="min-w-0 truncate">{singleLabel ? singleLabel.title : `已执行 ${toolCalls.length} 项操作`}</span>
        {singleLabel?.detail && <span className="min-w-0 truncate text-xs font-normal text-zinc-400">{singleLabel.detail}</span>}
        <span className="shrink-0">
          {isRunning
            ? <Loader2 className="h-3 w-3 animate-spin text-violet-400" />
            : hasError
              ? <XCircle className="h-3 w-3 text-red-400" />
              : <CheckCircle2 className="h-3 w-3 text-emerald-400" />}
        </span>
      </button>
      {open && (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-zinc-100 pl-2">
          {toolCalls.map((toolCall) => <ToolCallView key={toolCall.id} toolCall={toolCall} />)}
        </div>
      )}
    </div>
  )
}

function TimelineNoteRow({ content }: { content: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-500">
      <Info className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      <span className="min-w-0">{content}</span>
    </div>
  )
}

function ExecutionTimelineView({ entries, streaming = false }: { entries: ExecutionTimelineEntry[]; streaming?: boolean }) {
  const groups = groupTimelineEntries(entries).filter((group) => group.kind === 'tool' || group.kind === 'note')
  if (!groups.length) return null

  return (
    <section className="execution-feed__timeline" aria-label="工具活动">
      {groups.map((group) => group.kind === 'tool'
        ? <TimelineToolGroup key={group.entries[0].id} entries={group.entries} streaming={streaming} />
        : <TimelineNoteRow key={group.entries[0].id} content={group.entries[0].content || ''} />)}
    </section>
  )
}

const WAITING_MESSAGES = ['正在执行...', '请稍等片刻...', '正在处理中...', '还在继续，请稍候...', '正在准备回复...']

function ExecutionStatusIndicator() {
  const [messageIndex, setMessageIndex] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => {
      setMessageIndex((previous) => (previous + 1 + Math.floor(Math.random() * (WAITING_MESSAGES.length - 1))) % WAITING_MESSAGES.length)
    }, 4000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <div className="tool-execution-status mt-3 mb-2" role="status">
      <span className="sr-only">正在处理，请稍候</span>
      <span className="tool-execution-status__text" aria-hidden="true">{WAITING_MESSAGES[messageIndex]}</span>
    </div>
  )
}

type ProgressMarkdownOptions = {
  conversationId?: string
  outputFormat: AgentOutputFormat
  outputStyle: AgentOutputStyle
  outputFont: AgentOutputFont
  outputColor: AgentOutputColor
  outputFontSize: AgentOutputFontSize
  outputTextEffect: AgentOutputTextEffect
  markdownRenderer: AgentMarkdownRenderer
}

function ProgressMarkdown({ content, streaming, markdownOptions }: { content: string; streaming: boolean; markdownOptions: ProgressMarkdownOptions }) {
  return (
    <MarkdownMessageContent
      content={content}
      isStreaming={streaming}
      conversationId={markdownOptions.conversationId}
      outputFormat={markdownOptions.outputFormat}
      outputStyle={markdownOptions.outputStyle}
      outputFont={markdownOptions.outputFont}
      outputColor={markdownOptions.outputColor}
      outputFontSize={markdownOptions.outputFontSize}
      outputTextEffect={markdownOptions.outputTextEffect}
      markdownRenderer={markdownOptions.markdownRenderer}
    />
  )
}

function ProcessReportRow({ entry, streaming, markdownOptions }: { entry: ProcessReportEntry; streaming: boolean; markdownOptions: ProgressMarkdownOptions }) {
  if (!isStructuredReport(entry.kind)) {
    // Legacy free-form updates keep their compact row so old conversations
    // render exactly as before.
    return (
      <div className="execution-feed__update">
        <span className="execution-feed__update-icon" aria-hidden="true">
          {entry.kind === 'thinking' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : entry.kind === 'issue' ? <XCircle className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <span className="execution-feed__update-label">{processReportLabel(entry)}</span>
          <ProgressMarkdown content={entry.content} streaming={streaming} markdownOptions={markdownOptions} />
        </div>
      </div>
    )
  }

  // The work report is the main narrative of the run, so it is typeset like
  // the answer body while the tool rows around it stay deliberately quieter.
  return (
    <div className={cn('execution-feed__report', entry.kind === 'plan' && 'execution-feed__report--plan')}>
      <span className="execution-feed__report-header">{processReportLabel(entry)}</span>
      <ProgressMarkdown content={entry.content} streaming={streaming} markdownOptions={markdownOptions} />
    </div>
  )
}

function ProcessReportsView({ feed, streaming = false, markdownOptions }: { feed: ProcessFeed; streaming?: boolean; markdownOptions: ProgressMarkdownOptions }) {
  if (!feed.plan && feed.entries.length === 0) return null

  return (
    <section className="execution-feed__reports" aria-label="执行汇报" aria-live={streaming ? 'polite' : undefined}>
      {feed.checklist ? (
        <PlanChecklist
          checklist={feed.checklist}
          streaming={streaming}
          className="execution-feed__report execution-feed__report--plan"
          renderItemText={(text) => <ProgressMarkdown content={text} streaming={streaming} markdownOptions={markdownOptions} />}
        />
      ) : feed.plan ? <ProcessReportRow entry={feed.plan} streaming={streaming} markdownOptions={markdownOptions} /> : null}
      {feed.entries.map((entry) => <ProcessReportRow key={entry.id} entry={entry} streaming={streaming} markdownOptions={markdownOptions} />)}
    </section>
  )
}

function executionToolActivityLabel(toolCall: ToolCall): { title: string; detail?: string } {
  const path = typeof toolCall.arguments.path === 'string' ? toolCall.arguments.path : undefined
  const command = typeof toolCall.arguments.command === 'string'
    ? toolCall.arguments.command
    : typeof toolCall.arguments.text === 'string' ? toolCall.arguments.text : undefined
  if (toolCall.name === 'read_file' || toolCall.name === 'list_directory' || toolCall.name === 'search_files' || toolCall.name === 'search_code') return { title: '已读取文件', detail: path }
  if (toolCall.name === 'write_file' || toolCall.name === 'edit_file' || toolCall.name === 'apply_patch') return { title: '已编辑文件', detail: path }
  if (toolCall.name === 'execute_command' || toolCall.name === 'write_terminal') return { title: '已运行命令', detail: command }
  if (toolCall.name === 'web_search') return { title: '已搜索资料', detail: typeof toolCall.arguments.query === 'string' ? toolCall.arguments.query : undefined }
  if (toolCall.name === 'read_web_page') return { title: '已读取网页', detail: typeof toolCall.arguments.url === 'string' ? toolCall.arguments.url : undefined }
  return { title: '已执行操作', detail: toolCall.name }
}

function ExecutionFeedView({
  message,
  streaming = false,
  shouldShowReasoning,
  markdownOptions,
}: {
  message: ChatMessage
  streaming?: boolean
  shouldShowReasoning: boolean
  markdownOptions: ProgressMarkdownOptions
}) {
  const feed = buildProcessFeed(message.progressUpdates || [])
  const allTimelineEntries = message.executionTimeline || []
  const timelineEntries = allTimelineEntries.filter((entry) => entry.kind !== 'reasoning')
  // Raw reasoning travels either as timeline entries or as the message-level
  // accumulator, depending on when it arrived.
  const reasoningContent = allTimelineEntries
    .filter((entry) => entry.kind === 'reasoning')
    .map((entry) => entry.content || '')
    .join('\n\n')
    .trim() || message.reasoningContent || ''
  const hasReports = Boolean(feed.plan || feed.entries.length)
  const hasTimeline = timelineEntries.length > 0
  const hasReasoning = Boolean(shouldShowReasoning && reasoningContent)
  const hasActivity = hasReports || hasTimeline || hasReasoning
  if (!hasActivity) return null

  return (
    <section className="execution-feed" aria-label="工作进展" aria-live={streaming ? 'polite' : undefined}>
      {hasReports ? <ProcessReportsView feed={feed} streaming={streaming} markdownOptions={markdownOptions} /> : null}
      {hasTimeline ? <ExecutionTimelineView entries={timelineEntries} streaming={streaming} /> : null}
      {hasReasoning ? <ReasoningPanel content={reasoningContent} streaming={streaming} /> : null}
    </section>
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

function StreamdownLink({ children, href, node: _node, ...props }: React.ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  return <a href={href} target="_blank" rel="noreferrer noopener" {...props}>{children}<ExternalLink aria-hidden="true" className="markdown-external-link" /></a>
}

const streamdownBaseComponents = { a: StreamdownLink }

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

export function MarkdownMessageContent({ content, className, isStreaming = false, conversationId, outputFormat = 'default', outputStyle = 'balanced', outputFont = 'system', outputColor = 'slate', outputFontSize = 'medium', outputTextEffect = 'none', markdownRenderer = 'enhanced' }: { content: string; className?: string; isStreaming?: boolean; conversationId?: string; outputFormat?: AgentOutputFormat; outputStyle?: AgentOutputStyle; outputFont?: AgentOutputFont; outputColor?: AgentOutputColor; outputFontSize?: AgentOutputFontSize; outputTextEffect?: AgentOutputTextEffect; markdownRenderer?: AgentMarkdownRenderer }) {
  const markdownContent = isStreaming ? normalizeStreamingMarkdown(content) : normalizeChatMarkdown(content)
  const markdownClassName = cn('chat-message-markdown max-w-none', `chat-message-markdown--format-${outputFormat}`, `chat-message-markdown--${outputStyle}`, `chat-message-markdown--font-${outputFont}`, `chat-message-markdown--color-${outputColor}`, `chat-message-markdown--font-size-${outputFontSize}`, `chat-message-markdown--effect-${outputTextEffect}`, `chat-message-markdown--renderer-${markdownRenderer}`, className)

  // Path-like inline code becomes a clickable chip only once the reply is
  // complete: mid-stream the backtick span is still being auto-closed, so
  // chipping live text would flicker and mislabel partial tokens.
  const streamdownComponents = useMemo(() => ({
    ...streamdownBaseComponents,
    inlineCode: ({ children, ...props }: React.ComponentPropsWithoutRef<'code'> & { node?: unknown }) => {
      const inlineText = markdownNodeText(children)
      if (!isStreaming && isFilePathLikeCodeSpan(inlineText)) {
        return <FilePathChip text={inlineText} conversationId={conversationId} />
      }
      return <code className="markdown-inline-code" {...props}>{children}</code>
    },
  }), [isStreaming, conversationId])

  // Streamdown is used for every live reply because it can animate only the
  // newly appended characters. Once complete, the user's chosen renderer
  // takes over for the stable, fully formatted document.
  if (isStreaming || markdownRenderer === 'streamdown') {
    return (
      <div className={markdownClassName} aria-busy={isStreaming || undefined}>
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
    <div className={markdownClassName} aria-busy={isStreaming || undefined}>
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
              const inlineText = markdownNodeText(children)
              if (!isStreaming && isFilePathLikeCodeSpan(inlineText)) {
                return <FilePathChip text={inlineText} conversationId={conversationId} />
              }
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

export const MessageBubble = React.memo(function MessageBubble({ message, className, isStreaming = false, showActions = true, canRegenerate = false, conversationUsage }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isTool = message.role === 'tool'
  const language = useAppStore((state) => state.language)
  const agents = useAgentStore((state) => state.agents)
  const updateMessageFavorite = useChatStore((state) => state.updateMessageFavorite)
  const regenerateFromMessage = useChatStore((state) => state.regenerateFromMessage)
  const setQuotedMessage = useChatStore((state) => state.setQuotedMessage)
  const [copied, setCopied] = useState(false)
  const actionCopy = language === 'zh'
    ? { copy: '复制', copied: '已复制', favorite: '收藏', unfavorite: '取消收藏', regenerate: '重新生成' }
    : language === 'ja'
      ? { copy: 'コピー', copied: 'コピー済み', favorite: 'お気に入り', unfavorite: 'お気に入りを解除', regenerate: '再生成' }
      : { copy: 'Copy', copied: 'Copied', favorite: 'Favorite', unfavorite: 'Unfavorite', regenerate: 'Regenerate' }

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
  const processOutput = outputAgent?.processOutput || (outputAgent?.showThinking ? 'detailed' : 'compact')
  const shouldShowReasoning = processOutput === 'detailed'
  const outputStyle = outputAgent?.outputStyle || 'balanced'
  const outputFormat = outputAgent?.outputFormat || 'default'
  const outputFont = outputAgent?.outputFont || 'system'
  const outputColor = outputAgent?.outputColor || 'slate'
  const outputFontSize = outputAgent?.outputFontSize || 'medium'
  const outputTextEffect = outputAgent?.outputTextEffect || 'none'
  const markdownRenderer = outputAgent?.markdownRenderer || 'enhanced'

  // A progress event can be left on its own when a run is interrupted before
  // its final assistant message is persisted. Keep it visible in that case.
  if (message.progressKind) {
    if (processOutput === 'off') return null
    if (isInternalToolLifecycleUpdate(message.content)) return null
    return (
      <article className={cn('group flex items-start gap-3', className)}>
        <div className="chat-message-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-600">
          <Bot className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 max-w-[66rem]">
          <div className="chat-message-surface chat-assistant-message py-3 pl-3 pr-5">
            <ProcessReportsView
              feed={buildProcessFeed([{ id: message.id, kind: message.progressKind, content: message.content, timestamp: message.timestamp }], { numberSteps: false })}
              markdownOptions={{ outputFormat, outputStyle, outputFont, outputColor, outputFontSize, outputTextEffect, markdownRenderer }}
            />
          </div>
        </div>
      </article>
    )
  }

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
            {message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}
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
            <div className="chat-agent-label mb-3 flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
              <Badge variant="primary" className="px-1.5 py-0">
                {message.agentName}
              </Badge>
            </div>
          )}
          <ExecutionFeedView
            message={message}
            streaming={isStreaming}
            shouldShowReasoning={shouldShowReasoning}
            markdownOptions={{ conversationId: message.conversationId, outputFormat, outputStyle, outputFont, outputColor, outputFontSize, outputTextEffect, markdownRenderer }}
          />
          {isStreaming && !message.content.trim() ? <ExecutionStatusIndicator key={message.id} /> : null}
          <MarkdownMessageContent content={message.content} isStreaming={isStreaming} conversationId={message.conversationId} outputFormat={outputFormat} outputStyle={outputStyle} outputFont={outputFont} outputColor={outputColor} outputFontSize={outputFontSize} outputTextEffect={outputTextEffect} markdownRenderer={markdownRenderer} />
          {message.usage ? <UsageSummary usage={message.usage} conversationUsage={conversationUsage} /> : null}
          {message.timing ? <TimingSummary timing={message.timing} /> : null}
        </div>

        {!isStreaming && !isTool && showActions && (
          <div className="message-actions mt-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button type="button" onClick={quoteCurrentMessage} className="message-action inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-400 transition-colors" title="引用消息" aria-label="引用消息">
              <Quote className="h-3.5 w-3.5" />引用
            </button>
            {canRegenerate && (
              <button type="button" onClick={() => void regenerateFromMessage(message.id)} className="message-action inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-400 transition-colors" title={actionCopy.regenerate} aria-label={actionCopy.regenerate}>
                <RefreshCw className="h-3.5 w-3.5" />{actionCopy.regenerate}
              </button>
            )}
            <button type="button" onClick={() => void handleCopyAssistant()} className="message-action inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-400 transition-colors" title={actionCopy.copy} aria-label={actionCopy.copy}>
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}{copied ? actionCopy.copied : actionCopy.copy}
            </button>
            <button type="button" onClick={() => void updateMessageFavorite(message.id, !message.favorited)} className={cn('message-action inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors', message.favorited ? 'text-violet-600' : 'text-zinc-400')} title={message.favorited ? actionCopy.unfavorite : actionCopy.favorite} aria-label={message.favorited ? actionCopy.unfavorite : actionCopy.favorite}>
              <Heart className={cn('h-3.5 w-3.5', message.favorited && 'fill-current')} />{message.favorited ? actionCopy.unfavorite : actionCopy.favorite}
            </button>
          </div>
        )}

      </div>
    </article>
  )
})
