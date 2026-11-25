import { agentDisplayName } from '@/lib/agent-presentation'
import { canonicalToolName } from '../../../shared/tool-semantics'
import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import hljs from 'highlight.js/lib/common'
import 'streamdown/styles.css'
import type { AgentMarkdownRenderer, AgentOutputColor, AgentOutputFont, AgentOutputFontSize, AgentOutputFormat, AgentOutputStyle, AgentOutputTextEffect, ChatMessage, ExecutionTimelineEntry, ToolCall } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { ToolCallGroupView, ToolCallView } from './ToolCallView'
import { NativeAgentView } from './NativeAgentView'
import { ToolActivityList } from './ToolActivityList'
import { ConversationActivity } from './ConversationActivity'
import { groupToolActivity } from '@/lib/execution-activity'
import { PlanChecklist } from './PlanChecklist'
import { ReferenceImagePreview } from './ReferenceImagePreview'
import { Loader, Wrench, Copy, Check, Heart, Quote, ChevronDown, BrainCircuit, ExternalLink, FileText, FileSpreadsheet, FolderOpen, CheckCircle2, XCircle, Info, CircleDot, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { normalizeChatMarkdown, normalizeStreamingMarkdown } from '@/lib/markdown-display'
import { isFilePathLikeCodeSpan } from '@/lib/file-path-chip'
import { buildProcessFeed, isInternalToolLifecycleUpdate, isStructuredReport, processReportLabel, type ProcessFeed, type ProcessReportEntry } from '@/lib/process-report'
import { FilePathChip } from './FilePathChip'
import '@/styles/conversation-reading.css'
import { READING_FONT_SIZES } from '@/lib/reading-typography'
import { CHAT_TEXT_ANIMATION, CHAT_TEXT_ANIMATION_MAX_CHARS } from '@/lib/stream-presentation'
import { createInkRevealPlugin } from '@/lib/ink-reveal'
import type { BlockProps, StreamdownProps } from 'streamdown'

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
  isReasoningStreaming?: boolean
  /**
   * Whether the quote/copy/favorite row is offered. The live copy turns it off:
   * its id is synthetic, so these actions would address no stored row.
   */
  showActions?: boolean
  /** True only for the newest persisted reply, which is the one that may re-run its round. */
  canRegenerate?: boolean
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

function ReasoningPanel({ content, streaming = false, outputFont, outputFontSize }: { content: string; streaming?: boolean; outputFont: AgentOutputFont; outputFontSize: AgentOutputFontSize }) {
  const language = useAppStore(state => state.language)
  const [open, setOpen] = useState(streaming)
  const previous = useRef(streaming)
  const closeTimer = useRef<number | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useEffect(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    if (streaming && !previous.current) { setOpen(true); following.current = true }
    if (!streaming && previous.current) closeTimer.current = window.setTimeout(() => setOpen(false), 1000)
    previous.current = streaming
    return () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current) }
  }, [streaming])
  useEffect(() => { if (open && body.current && following.current) body.current.scrollTop = body.current.scrollHeight }, [content, open])
  const label = language === 'zh' ? (streaming ? '思考中…' : '思考内容') : language === 'ja' ? (streaming ? '考え中…' : '思考内容') : (streaming ? 'Thinking…' : 'Thinking')
  return <section className={cn('conversation-reasoning', streaming && 'conversation-reasoning--streaming')} data-provider-reasoning>
    <button type="button" className="conversation-reasoning__trigger" aria-expanded={open} onClick={() => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
      setOpen(value => !value)
    }}>
      <BrainCircuit aria-hidden="true" /><span>{label}</span><ChevronDown aria-hidden="true" className={cn(open && 'is-open')} />
    </button>
    {open && <div ref={body} className="conversation-reasoning__content" onScroll={event => {
      const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    }}>
      <MarkdownMessageContent readingStandard preserveSource content={content} isStreaming={streaming} outputFont={outputFont} outputFontSize={outputFontSize} />
    </div>}
  </section>
}

function TimelineToolGroup({ entries, streaming = false }: { entries: readonly { toolCall?: ToolCall }[]; streaming?: boolean }) {
  const toolCalls = entries.flatMap((entry) => entry.toolCall ? [entry.toolCall] : [])
  if (toolCalls.length === 0) return null
  const hasUnconfirmed = toolCalls.some((toolCall) => toolCall.result === undefined && !toolCall.isError)
  const isRunning = streaming && hasUnconfirmed
  return <ToolActivityList toolCount={toolCalls.length} streaming={isRunning}
    errorCount={toolCalls.filter(tool => tool.isError).length}
    unconfirmedCount={streaming ? 0 : toolCalls.filter(tool => tool.result === undefined && !tool.isError).length}
    commandsOnly={toolCalls.every(tool => canonicalToolName(tool.name) === 'execute_command')}>
    {toolCalls.map(toolCall => <ToolCallView compact key={toolCall.id} toolCall={toolCall} active={streaming} />)}
  </ToolActivityList>
}

function TimelineNoteRow({ content }: { content: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-500">
      <Info className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      <span className="min-w-0">{content}</span>
    </div>
  )
}

function ExecutionStatusIndicator() {
  const language = useAppStore(state => state.language)
  return <div className="conversation-loading" role="status" data-conversation-loading>
    <Loader className="conversation-loading__spinner" aria-hidden="true" />
    <span>{language === 'zh' ? '正在回复…' : language === 'ja' ? '返信中…' : 'Responding…'}</span>
  </div>
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
      readingStandard
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
    return (
      <div className="activity-narration" data-public-report={entry.id}>
        <ProgressMarkdown content={entry.content} streaming={streaming} markdownOptions={markdownOptions} />
      </div>
    )
  }

  // The work report is the main narrative of the run, so it is typeset like
  // the answer body while the tool rows around it stay deliberately quieter.
  return (
    <div className={cn('execution-feed__report', entry.kind === 'plan' && 'execution-feed__report--plan')} data-public-report={entry.id}>
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

function ExecutionFeedView({
  message,
  streaming = false,
  markdownOptions,
}: {
  message: ChatMessage
  streaming?: boolean
  markdownOptions: ProgressMarkdownOptions
}) {
  const feed = buildProcessFeed(message.progressUpdates || [])
  const allTimelineEntries = message.executionTimeline || []
  // Status notes ("正在汇总已验证的结果。") are live progress. Once the round has
  // settled they claim work that already ended. Keep their ordering boundaries
  // so tool batches do not merge, but render the notes only while streaming.
  const timelineEntries = allTimelineEntries.filter((entry) => entry.kind !== 'reasoning')
  const hasReports = Boolean(feed.plan || feed.entries.length)
  const hasTimeline = timelineEntries.some(entry => entry.kind === 'tool' || streaming)
  const hasActivity = hasReports || hasTimeline
  if (!hasActivity) return null

  type ActivityEntry = { id: string; kind: 'tool' | 'note' | 'report'; timestamp: number; toolCall?: ToolCall; content?: string; report?: ProcessReportEntry }
  const updates = new Map((message.progressUpdates || []).map(update => [update.id, update]))
  const reports = [...(feed.plan ? [feed.plan] : []), ...feed.entries]
  // Existing timestamps are the common ordering signal for Eva's separate
  // public-report and tool streams. Ties keep report publication order first.
  const activity: ActivityEntry[] = [
    ...reports.map(report => ({ id: `report:${report.id}`, kind: 'report' as const, timestamp: updates.get(report.id)?.timestamp || 0, report })),
    ...timelineEntries.map(entry => ({ ...entry, kind: entry.kind as 'tool' | 'note' })),
  ].sort((a, b) => a.timestamp - b.timestamp)
  return <ConversationActivity label="工作进展" items={groupToolActivity(activity).map(group => {
    if (group.kind === 'tools') {
      const tools = group.items.flatMap(entry => entry.toolCall ? [entry.toolCall] : [])
      return { id: group.id, kind: 'tools' as const,
        attachments: [...new Map(tools.flatMap(tool => tool.images || []).map(image => [image.path, image])).values()]
          .map(image => <ReferenceImagePreview key={image.path} image={image} className="h-24 w-24 rounded-md" />),
        content: <TimelineToolGroup entries={group.items} streaming={streaming} /> }
    }
    return { id: group.id, kind: 'item' as const, content: group.item.kind === 'report' && group.item.report
          ? group.item.report === feed.plan && feed.checklist
            ? <PlanChecklist key={group.id} checklist={feed.checklist} streaming={streaming} className="execution-feed__report execution-feed__report--plan"
                renderItemText={text => <ProgressMarkdown content={text} streaming={streaming} markdownOptions={markdownOptions} />} />
            : <ProcessReportRow key={group.id} entry={group.item.report} streaming={streaming} markdownOptions={markdownOptions} />
          : streaming ? <TimelineNoteRow key={group.id} content={group.item.content || ''} /> : null }
  })} />
}

function markdownNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(markdownNodeText).join('')
  if (React.isValidElement<{ children?: ReactNode }>(node)) return markdownNodeText(node.props.children)
  return ''
}

const MarkdownBlockCodeContext = React.createContext(false)

function MarkdownCodeBlock({ children, language }: { children: ReactNode; language?: string }) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const uiLanguage = useAppStore(state => state.language)
  const code = markdownNodeText(children).replace(/\n$/, '')
  const canCollapse = code.split('\n').length > 24
  const copyLabel = uiLanguage === 'zh' ? (copied ? '已复制' : '复制代码') : uiLanguage === 'ja' ? (copied ? 'コピー済み' : 'コードをコピー') : (copied ? 'Copied' : 'Copy code')
  const collapseLabel = uiLanguage === 'zh' ? (expanded ? '收起代码' : '展开代码') : uiLanguage === 'ja' ? (expanded ? 'コードを折りたたむ' : 'コードを展開') : (expanded ? 'Collapse code' : 'Expand code')

  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="markdown-code-block group" data-code-expanded={canCollapse ? expanded : undefined} style={{ '--code-visible-lines': expanded ? 48 : 24 } as React.CSSProperties}>
      <div className="markdown-code-block__bar">
        <span>{language || 'text'}</span>
        <div className="markdown-code-block__actions">
        {canCollapse && <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} title={collapseLabel} aria-label={collapseLabel}><ChevronDown className={cn('h-3.5 w-3.5', expanded && 'rotate-180')} /></button>}
        <button type="button" onClick={() => void copy()} title={copyLabel} aria-label="Copy code">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        </div>
      </div>
      <pre><MarkdownBlockCodeContext.Provider value={true}>{children}</MarkdownBlockCodeContext.Provider></pre>
    </div>
  )
}

function StreamdownLink({ children, href, node: _node, ...props }: React.ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  return <a href={href} target="_blank" rel="noreferrer noopener" {...props}>{children}<ExternalLink aria-hidden="true" className="markdown-external-link" /></a>
}

/** Preserve literal newlines and the existing copy/highlighting contract in
 * both live and completed chat, including fences without a language label. */
function ReadingBlockCode({ children, className }: React.ComponentPropsWithoutRef<'code'>) {
  const code = markdownNodeText(children)
  const language = className?.match(/language-([^\s]+)/)?.[1]
  const highlighted = useMemo(() => language && hljs.getLanguage(language)
    ? hljs.highlight(code, { language, ignoreIllegals: true }).value
    : null, [code, language])
  return <MarkdownCodeBlock language={language}>
    {highlighted === null ? <code className={className}>{code}</code>
      // Only highlight.js's escaped token markup enters this HTML sink.
      : <code className={className} dangerouslySetInnerHTML={{ __html: highlighted }} />}
  </MarkdownCodeBlock>
}

const streamdownBaseComponents = { a: StreamdownLink }
// A single tilde commonly denotes a range in Chinese prose. Only explicit
// double-tilde Markdown should produce a deletion, including in previews.
const markdownGfmPlugin: [typeof remarkGfm, { singleTilde: boolean }] = [remarkGfm, { singleTilde: false }]

const StreamdownRenderer = React.lazy(async () => {
  const { Streamdown, Block, defaultRemarkPlugins } = await import('streamdown')
  const remarkPlugins = Object.entries(defaultRemarkPlugins).map(([name, plugin]) => name === 'gfm' ? markdownGfmPlugin : plugin)
  function IncrementalBlock(props: BlockProps) {
    const enabled = Boolean(props.animatePlugin)
    // Each Markdown block owns its previous character count. Sharing that
    // count would mistake the start of a new paragraph for already-shown text.
    const animation = useMemo(() => enabled ? createInkRevealPlugin() : null, [enabled])
    const rehypePlugins = useMemo(() => props.rehypePlugins?.map(plugin =>
      plugin === props.animatePlugin?.rehypePlugin && animation ? animation.rehypePlugin : plugin
    ), [props.rehypePlugins, props.animatePlugin, animation])
    return <Block {...props} animatePlugin={animation} rehypePlugins={rehypePlugins} />
  }
  return { default: (props: StreamdownProps) => <Streamdown {...props} remarkPlugins={remarkPlugins} BlockComponent={IncrementalBlock} /> }
})

function safeStreamdownUrl(url: string): string {
  const normalized = url.trim()
  return /^(https?:|mailto:)/i.test(normalized) || normalized.startsWith('/') || normalized.startsWith('#')
    ? normalized
    : ''
}

export function MarkdownMessageContent({ content, className, isStreaming = false, conversationId, outputFormat = 'default', outputStyle = 'balanced', outputFont = 'system', outputColor = 'slate', outputFontSize = 'medium', outputTextEffect = 'none', markdownRenderer = 'enhanced', preserveSource = false, readingStandard = false }: { content: string; className?: string; isStreaming?: boolean; conversationId?: string; outputFormat?: AgentOutputFormat; outputStyle?: AgentOutputStyle; outputFont?: AgentOutputFont; outputColor?: AgentOutputColor; outputFontSize?: AgentOutputFontSize; outputTextEffect?: AgentOutputTextEffect; markdownRenderer?: AgentMarkdownRenderer; preserveSource?: boolean; readingStandard?: boolean }) {
  // The incremental parser repairs unfinished Markdown itself. Stripping a
  // pending ** marker would change text structure again when the pair closes.
  const markdownContent = preserveSource ? content : readingStandard ? normalizeChatMarkdown(content) : isStreaming ? normalizeStreamingMarkdown(content) : normalizeChatMarkdown(content)
  const markdownClassName = cn('chat-message-markdown max-w-none', readingStandard && 'conversation-reading', `chat-message-markdown--format-${outputFormat}`, `chat-message-markdown--${outputStyle}`, `chat-message-markdown--font-${outputFont}`, `chat-message-markdown--color-${outputColor}`, `chat-message-markdown--font-size-${outputFontSize}`, `chat-message-markdown--effect-${outputTextEffect}`, `chat-message-markdown--renderer-${markdownRenderer}`, className)
  const readingStyle = readingStandard ? { '--reading-size': `${READING_FONT_SIZES[outputFontSize]}px` } as React.CSSProperties : undefined

  // Path-like inline code becomes a clickable chip only once the reply is
  // complete: mid-stream the backtick span is still being auto-closed, so
  // chipping live text would flicker and mislabel partial tokens.
  const streamdownComponents = useMemo(() => ({
    ...streamdownBaseComponents,
    ...(readingStandard ? {
      // Streamdown normally renders emphasis as a span. Use the same semantic
      // element as the static renderers so the reading contract applies to both.
      strong: ({ children }: React.ComponentPropsWithoutRef<'strong'>) => <strong>{children}</strong>,
      code: ReadingBlockCode,
    } : {}),
    inlineCode: ({ children, node: _node, ...props }: React.ComponentPropsWithoutRef<'code'> & { node?: unknown }) => {
      const inlineText = markdownNodeText(children)
      if (!isStreaming && isFilePathLikeCodeSpan(inlineText)) {
        return <FilePathChip text={inlineText} conversationId={conversationId} />
      }
      return <code className="markdown-inline-code" {...props}>{children}</code>
    },
  }), [isStreaming, conversationId, readingStandard])

  // Chat keeps the same Markdown renderer through completion. Document
  // previews retain their chosen renderer and independent presentation.
  if (readingStandard || isStreaming || markdownRenderer === 'streamdown') {
    return (
      <div className={markdownClassName} style={readingStyle} data-reading-standard={readingStandard || undefined} aria-busy={isStreaming || undefined}>
        <React.Suspense fallback={<div className="whitespace-pre-wrap">{markdownContent}</div>}>
          <StreamdownRenderer
            mode={isStreaming ? "streaming" : "static"}
            isAnimating={isStreaming}
            animated={readingStandard && isStreaming && content.length <= CHAT_TEXT_ANIMATION_MAX_CHARS ? CHAT_TEXT_ANIMATION : false}
            parseIncompleteMarkdown
            lineNumbers={readingStandard ? false : undefined}
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
    <div className={markdownClassName} style={readingStyle} data-reading-standard={readingStandard || undefined} aria-busy={isStreaming || undefined}>
      <ReactMarkdown
        remarkPlugins={[markdownGfmPlugin]}
        rehypePlugins={isStreaming ? [] : [rehypeHighlight]}
        components={{
          pre({ children }) {
            const codeElement = React.Children.toArray(children).find(React.isValidElement)
            const codeClassName = React.isValidElement<{ className?: string }>(codeElement) ? codeElement.props.className : undefined
            const language = codeClassName?.match(/language-([^\s]+)/)?.[1]
            return <MarkdownCodeBlock language={language}>{children}</MarkdownCodeBlock>
          },
          code({ children, className: codeClassName, node: _node, ...props }) {
            const insideBlock = React.useContext(MarkdownBlockCodeContext)
            if (!insideBlock && !codeClassName) {
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

export const MessageBubble = React.memo(function MessageBubble({ message, className, isStreaming = false, isReasoningStreaming = false, showActions = true, canRegenerate = false }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isTool = message.role === 'tool'
  const language = useAppStore((state) => state.language)
  const agents = useAgentStore((state) => state.agents)
  const author = agents.find(agent => agent.id === message.agentId)
  const displayedAuthor = author && message.agentName === author.name ? agentDisplayName(author, language) : message.agentName
  const updateMessageFavorite = useChatStore((state) => state.updateMessageFavorite)
  const regenerateFromMessage = useChatStore((state) => state.regenerateFromMessage)
  const setQuotedMessage = useChatStore((state) => state.setQuotedMessage)
  const [copied, setCopied] = useState(false)
  const actionCopy = language === 'zh'
    ? { copy: '复制', copied: '已复制', favorite: '收藏', unfavorite: '取消收藏', regenerate: '重新生成', quote: '引用消息' }
    : language === 'ja'
      ? { copy: 'コピー', copied: 'コピー済み', favorite: 'お気に入り', unfavorite: 'お気に入りを解除', regenerate: '再生成', quote: 'メッセージを引用' }
      : { copy: 'Copy', copied: 'Copied', favorite: 'Favorite', unfavorite: 'Unfavorite', regenerate: 'Regenerate', quote: 'Quote message' }

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
  // Only explicitly attributed provider responses can enter the thinking UI.
  // Legacy/internal reasoning is hidden and never becomes execution evidence.
  const providerReasoning = message.reasoningSource === 'provider-response' ? message.reasoningContent || '' : ''
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
        <div className="min-w-0 max-w-[66rem]">
          <div className="chat-message-surface chat-assistant-message py-2">
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
                {displayedAuthor}
              </Badge>
            )}
            {message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}
            {message.attachedSkillName ? (
              <div className="mb-2 inline-flex max-w-full items-center gap-1.5 self-start rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-xs leading-5 text-violet-700">
                <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">本次选用技能 {message.attachedSkillName}</span>
              </div>
            ) : null}
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
    <article className={cn('group chat-assistant-row flex items-start gap-3', className)} data-native-engine={message.nativeAgent?.engine} aria-label={displayedAuthor || undefined}>
      {isTool && <div className="chat-message-avatar flex h-8 w-8 shrink-0 items-center justify-center"><Wrench className="h-3.5 w-3.5" /></div>}

      {/* Content */}
      <div className="min-w-0 w-full max-w-[78ch]">
        <div className={cn('chat-message-surface chat-assistant-message py-2', `chat-assistant-message--format-${outputFormat}`)}>
          {providerReasoning && <ReasoningPanel key={`${message.conversationId}:provider-reasoning`} content={providerReasoning} streaming={isStreaming && isReasoningStreaming} outputFont={outputFont} outputFontSize={outputFontSize} />}
          {message.nativeAgent ? <NativeAgentView collapsible transcript={message.nativeAgent} finalContent={message.content} streaming={isStreaming}
            renderMarkdown={(content, streaming) => <MarkdownMessageContent readingStandard preserveSource content={content} isStreaming={streaming} conversationId={message.conversationId} outputStyle={outputStyle} outputFont={outputFont} outputColor={outputColor} outputFontSize={outputFontSize} />} /> : <ExecutionFeedView
            message={message}
            streaming={isStreaming}
            markdownOptions={{ conversationId: message.conversationId, outputFormat, outputStyle, outputFont, outputColor, outputFontSize, outputTextEffect, markdownRenderer }}
          />}
          {isStreaming && !message.content.trim() && !isReasoningStreaming ? <ExecutionStatusIndicator key={message.id} /> : null}
          <div className="conversation-answer" data-conversation-answer>
          <MarkdownMessageContent readingStandard preserveSource={Boolean(message.nativeAgent)} content={message.content} isStreaming={isStreaming} conversationId={message.conversationId} outputFormat={outputFormat} outputStyle={outputStyle} outputFont={outputFont} outputColor={outputColor} outputFontSize={outputFontSize} outputTextEffect={outputTextEffect} markdownRenderer={markdownRenderer} />
          </div>
        </div>

        {!isStreaming && !isTool && showActions && (
          <div className="message-actions chat-reply-actions" role="group" aria-label={language === 'zh' ? '回复操作' : language === 'ja' ? '返信操作' : 'Reply actions'}>
            <button type="button" onClick={() => void handleCopyAssistant()} className="message-action" title={copied ? actionCopy.copied : actionCopy.copy} aria-label={copied ? actionCopy.copied : actionCopy.copy}>
              {copied ? <Check className="text-emerald-500" /> : <Copy />}
            </button>
            {canRegenerate && (
              <button type="button" onClick={() => void regenerateFromMessage(message.id)} className="message-action" title={actionCopy.regenerate} aria-label={actionCopy.regenerate}>
                <RefreshCw />
              </button>
            )}
            <button type="button" onClick={quoteCurrentMessage} className="message-action" title={actionCopy.quote} aria-label={actionCopy.quote}>
              <Quote />
            </button>
            <button type="button" onClick={() => void updateMessageFavorite(message.id, !message.favorited)} className="message-action" aria-pressed={Boolean(message.favorited)} title={message.favorited ? actionCopy.unfavorite : actionCopy.favorite} aria-label={message.favorited ? actionCopy.unfavorite : actionCopy.favorite}>
              <Heart className={cn(message.favorited && 'fill-current text-violet-600')} />
            </button>
          </div>
        )}

      </div>
    </article>
  )
})
