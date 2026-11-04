import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Check, ChevronRight, Circle, FileText, Loader2, Terminal, Wrench, X } from 'lucide-react'
import type { NativeAgentTranscript } from '../../../shared/types/native-agent'
import {
  NATIVE_AGENT_PRESENTERS,
  projectNativeTranscript,
  type NativeTranscriptItem,
} from '../../../shared/native-agent-transcript'
import { ToolActivityList } from './ToolActivityList'
import { groupToolActivity } from '@/lib/execution-activity'
import { canonicalToolName } from '../../../shared/tool-semantics'

const useActivityLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

/** Render the Harness tool's own render intent, keeping Eva's typography and surface. */
function NativeToolCard({
  view,
  pending = false,
}: {
  view: Record<string, unknown>
  pending?: boolean
}) {
  if (view.card === 'read' && Array.isArray(view.lines))
    return (
      <div data-native-presentation="read">
        <div className="mb-1 text-[11px] text-zinc-400">
          {String(view.path || '')}
          {typeof view.totalLines === 'number'
            ? ` · ${view.totalLines} 行`
            : ''}
          {view.truncated ? ' · 已截断' : ''}
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">
          {view.lines.map((line) => `${line.number}  ${line.text}`).join('\n')}
        </pre>
      </div>
    )
  if (view.card === 'terminal' && typeof view.output === 'string')
    return (
      <div data-native-presentation="terminal">
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">
          {view.output}
        </pre>
        {typeof view.exitCode === 'number' ? (
          <div className="text-[11px] text-zinc-400">
            退出码 {view.exitCode}
          </div>
        ) : null}
      </div>
    )
  if (view.card === 'diff' && Array.isArray(view.diffs))
    return (
      <div className="space-y-2" data-native-presentation="diff">
        {pending ? (
          <div className="text-[11px] text-zinc-400">计划变更</div>
        ) : null}
        {view.diffs.map((diff, index) => (
          <div key={index}>
            <div className="mb-1 break-all text-xs text-zinc-500">
              {String(diff.path || '')}
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-2">
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-l-2 border-red-300 pl-2 font-mono text-xs">
                {diff.oldText === null
                  ? '（新文件）'
                  : String(diff.oldText || '')}
              </pre>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-l-2 border-emerald-300 pl-2 font-mono text-xs">
                {String(diff.newText || '')}
              </pre>
            </div>
          </div>
        ))}
      </div>
    )
  return null
}

/** Eva owns the visual surface. Native SDK events own order, labels and tool output. */
export function NativeAgentView({
  transcript,
  finalContent,
  streaming,
  renderMarkdown,
  collapsible = false,
}: {
  transcript: NativeAgentTranscript
  finalContent: string
  streaming: boolean
  renderMarkdown(content: string): ReactNode
  collapsible?: boolean
}) {
  const profile = NATIVE_AGENT_PRESENTERS[transcript.engine]
  const items = projectNativeTranscript(transcript)
  const activity = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const feedKey = `${transcript.engine}:${transcript.events[0]?.runId || ''}`
  const previousFeed = useRef(feedKey)
  const lastSequence = transcript.events[transcript.events.length - 1]?.sequence
  useActivityLayoutEffect(() => {
    if (previousFeed.current !== feedKey) {
      following.current = true
      previousFeed.current = feedKey
    }
    const element = activity.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [feedKey, lastSequence])
  const lastMessage = [...items]
    .reverse()
    .find((item) => item.kind === 'message' && item.content)
  const visibleItems = items.filter(item => item !== lastMessage || item.content !== finalContent)
  const hasDetails = visibleItems.some(item => item.kind === 'message' ? Boolean(item.content) : item.kind !== 'status' || item.eventType !== 'session')
  const renderItem = (item: NativeTranscriptItem) => {
          if (item.kind === 'message') {
            if (
              !item.content ||
              (item === lastMessage && item.content === finalContent)
            )
              return null
            return (
              <div key={item.id} className="activity-narration" data-native-message={item.id}>
                {renderMarkdown(item.content)}
              </div>
            )
          }
          if (item.kind === 'todo') {
            const todos = item.data?.todos
            if (!Array.isArray(todos)) return null
            return (
              <div
                key={item.id}
                className="rounded-lg border border-zinc-200/70 px-3 py-2"
                aria-label="Harness 任务列表"
              >
                {todos.map(
                  (todo: { content: string; status: string }, i: number) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 py-1 text-xs leading-5"
                    >
                      {todo.status === 'completed' ? (
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      ) : todo.status === 'in_progress' && streaming ? (
                        <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-violet-500" />
                      ) : (
                        <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      )}
                      <span>{todo.content}</span>
                      <span className="ml-auto shrink-0 text-zinc-400">
                        {todo.status}
                      </span>
                    </div>
                  ),
                )}
              </div>
            )
          }
          if (item.kind === 'goal')
            return (
              <div
                key={item.id}
                className="rounded-lg border border-zinc-200/70 px-3 py-2 text-xs leading-5"
                aria-label="Harness 原生目标"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">Harness Goal</span>
                  <span className="text-zinc-400">
                    {String(item.data?.phase || '')}
                  </span>
                </div>
                <div>{String(item.data?.objective || '')}</div>
                {item.data?.blockedReason &&
                typeof item.data.blockedReason === 'object' ? (
                  <div className="text-zinc-500">
                    {String(
                      (item.data.blockedReason as { message?: string })
                        .message || '',
                    )}
                  </div>
                ) : null}
              </div>
            )
          if (item.kind === 'status') {
            const labels: Record<string, string> = {
              compaction_start: '正在压缩原生上下文',
              compaction_end: '原生上下文压缩完成',
              retry: `原生请求恢复：第 ${item.data?.retry ?? ''} 次重试`,
              session: item.data?.resumed ? '已续接原生会话' : '已创建原生会话',
            }
            return (
              <div
                key={item.id}
                className="text-xs text-zinc-400"
                data-native-status={item.eventType}
              >
                {labels[item.eventType || ''] || item.eventType}
              </div>
            )
          }
          const target =
            item.arguments?.[profile.pathKey] ?? item.arguments?.command
          const view = item.resultView || item.callView
          const active = streaming && item.status === 'running'
          const failed = item.status === 'failed' || item.status === 'rejected'
          return (
            <details
              key={item.id}
              className="native-tool-row group/native"
              data-native-tool={item.name}
              data-native-card={view?.card || 'generic'}
            >
              <summary className="native-tool-row__summary" title={`${item.name || ''} · ${String(target || '')}`}>
                <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open/native:rotate-90" />
                {active ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-500" />
                ) : failed ? (
                  <X className="h-3.5 w-3.5 shrink-0 text-red-500" />
                ) : item.status === 'completed' ? (
                  canonicalToolName(item.name || '') === 'execute_command'
                    ? <Terminal className="h-3.5 w-3.5 shrink-0" />
                    : canonicalToolName(item.name || '').includes('file')
                      ? <FileText className="h-3.5 w-3.5 shrink-0" /> : <Wrench className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <Wrench className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                )}
                <span
                  className="shrink-0 font-normal"
                  title={item.name}
                >
                  {typeof view?.title === 'string' ? view.title : item.name}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {typeof target === 'string' ? target : ''}
                </span>
              </summary>
              <div className="native-tool-row__details">
                <span className="text-xs text-zinc-400" data-native-source>
                  {item.implementation === 'eva-extension'
                    ? 'Eva 扩展'
                    : item.implementation === 'native' ? `${profile.label} 原生` : `${profile.label} 工具`}
                </span>
                {view && !failed ? (
                  <NativeToolCard
                    view={view}
                    pending={item.status === 'running'}
                  />
                ) : null}
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-zinc-500">
                  {JSON.stringify(item.arguments || {}, null, 2)}
                </pre>
                {item.content ? (
                  <pre
                    className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5"
                    data-native-output
                  >
                    {item.content}
                  </pre>
                ) : null}
                {!active && item.status === 'running' ? (
                  <div className="text-xs text-zinc-400">
                    执行已中断，结果未确认
                  </div>
                ) : null}
              </div>
            </details>
          )
  }
  if (!collapsible) return <section className="execution-feed native-agent-feed" data-native-agent={transcript.engine}>
    <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">{streaming && <Loader2 className="h-3 w-3 animate-spin" />}{profile.label}</div>
    <div ref={activity} data-native-activity className="max-h-[28rem] space-y-3 overflow-y-auto overscroll-contain pr-1"
      onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>
      {items.map(renderItem)}
    </div>
  </section>
  if (!hasDetails && !streaming) return null
  const groups = groupToolActivity(visibleItems.filter(item => item.kind !== 'message' || Boolean(item.content)))
  return <section className="execution-feed native-agent-feed chronological-activity" data-native-agent={transcript.engine} aria-label={`${profile.label} 执行过程`}>
    {groups.map(group => group.kind === 'tools'
      ? <ToolActivityList key={group.id} toolCount={group.items.length}
          streaming={streaming && group.items.some(item => item.status === 'running')}
          errorCount={group.items.filter(item => item.status === 'failed' || item.status === 'rejected').length}
          unconfirmedCount={streaming ? 0 : group.items.filter(item => item.status === 'running').length}
          commandsOnly={group.items.every(item => canonicalToolName(item.name || '') === 'execute_command')}>
          {group.items.map(renderItem)}
        </ToolActivityList>
      : renderItem(group.item))}
    {streaming && !hasDetails && <Loader2 className="h-3 w-3 animate-spin" aria-label="原生运行中" />}
  </section>
}
