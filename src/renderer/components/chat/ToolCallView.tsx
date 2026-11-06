import React, { useState } from 'react'
import type { ToolCall } from '../../../shared/types'
import { canonicalToolName, toolImplementationLabel, toolTargetPath } from '../../../shared/tool-semantics'
import { cn } from '@/lib/utils'
import { ChevronRight, FileCode, Terminal, Search, Loader2, CheckCircle2, XCircle, CircleDot, Wrench, ExternalLink, Image as ImageIcon } from 'lucide-react'
import { ReferenceImagePreview } from './ReferenceImagePreview'

function getToolIcon(name: string) {
  name = canonicalToolName(name)
  if (name === 'dispatch_tools') return <Wrench className="h-3.5 w-3.5" />
  if (name === 'generate_image') return <ImageIcon className="h-3.5 w-3.5" />
  if (name.includes('file') || name.includes('read') || name.includes('write'))
    return <FileCode className="h-3.5 w-3.5" />
  if (name.includes('execute') || name.includes('terminal') || name.includes('command'))
    return <Terminal className="h-3.5 w-3.5" />
  if (name.includes('search'))
    return <Search className="h-3.5 w-3.5" />
  return <FileCode className="h-3.5 w-3.5" />
}

export function getToolLabel(toolCall: ToolCall): { title: string; detail?: string; resultCount?: number } {
  if (canonicalToolName(toolCall.name) === 'execute_command') {
    return { title: toolCall.name, detail: typeof toolCall.arguments.command === 'string' ? toolCall.arguments.command : undefined }
  }
  if (toolCall.name === 'dispatch_tools') {
    const calls = Array.isArray(toolCall.arguments.calls) ? toolCall.arguments.calls : []
    const names = Array.from(new Set(calls.flatMap((call) => typeof call === 'object' && call && typeof (call as Record<string, unknown>).name === 'string'
      ? [(call as Record<string, unknown>).name as string]
      : [])))
    return {
      title: '工具批次',
      detail: names.length ? `${calls.length} 项：${names.slice(0, 3).join('、')}${names.length > 3 ? '…' : ''}` : undefined,
    }
  }

  if (toolCall.name === 'delegate_to_model_pool') {
    const poolId = typeof toolCall.arguments.poolId === 'string' ? toolCall.arguments.poolId : ''
    const capability = typeof toolCall.arguments.capability === 'string' ? toolCall.arguments.capability : ''
    return { title: 'Model pool', detail: [poolId, capability].filter(Boolean).join(' / ') || 'Delegated model' }
  }

  if (toolCall.name === 'generate_image') {
    const prompt = typeof toolCall.arguments.prompt === 'string' ? toolCall.arguments.prompt : ''
    return { title: 'Generate image', detail: prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt }
  }

  if (toolCall.name === 'web_search') {
    const query = typeof toolCall.arguments.query === 'string' ? toolCall.arguments.query : ''
    const resultCount = toolCall.result?.match(/^\d+\.\s/gm)?.length
    return { title: 'Web search', detail: query, resultCount }
  }

  if (toolCall.name === 'read_web_page') {
    const rawUrl = typeof toolCall.arguments.url === 'string' ? toolCall.arguments.url : ''
    try {
      return { title: 'Read web page', detail: new URL(rawUrl).hostname }
    } catch {
      return { title: 'Read web page', detail: rawUrl }
    }
  }

  return { title: toolCall.name, detail: toolTargetPath(toolCall.arguments) }
}

interface SearchSource {
  rank: number
  title: string
  url: string
  host: string
  snippet: string
}

function parseSearchSources(result?: string): SearchSource[] {
  if (!result) return []

  return result
    .split(/\n\s*\n(?=\d+\.\s)/)
    .map((block, index) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
      const rankMatch = lines[0]?.match(/^(\d+)\.\s*(.*)$/)
      const rank = Number(rankMatch?.[1]) || index + 1
      const firstLine = rankMatch?.[2] || lines[0] || ''
      const url = lines.find((line) => /^https?:\/\//i.test(line)) || ''
      const snippet = lines
        .filter((line) => line !== url && line !== lines[0])
        .join(' ')
      let host = ''
      try { host = url ? new URL(url).hostname.replace(/^www\./, '') : '' } catch { /* Ignore malformed result URLs. */ }
      const title = firstLine && !/^https?:\/\//i.test(firstLine)
        ? firstLine
        : host || `Source ${rank}`
      return { rank, title, url, host, snippet }
    })
    .filter((source) => source.url || source.title)
}

function formatArgumentValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function dispatchCallSummary(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const call = value as Record<string, unknown>
  const name = typeof call.name === 'string' ? call.name : ''
  const id = typeof call.id === 'string' ? call.id : ''
  if (!name) return undefined
  return id ? `${name} (${id})` : name
}

export interface ToolCallViewProps {
  toolCall: ToolCall
  className?: string
  active?: boolean
  compact?: boolean
}

export interface ToolCallGroupViewProps {
  toolCalls: ToolCall[]
  className?: string
}

export function ToolCallGroupView({ toolCalls, className }: ToolCallGroupViewProps) {
  const isRunning = toolCalls.some((toolCall) => !toolCall.result && !toolCall.isError)
  if (!isRunning) return null

  return (
    <div className={cn('tool-execution-status', className)} role="status" aria-live="polite">
      <span className="tool-execution-status__text">正在执行 . . .</span>
    </div>
  )
}

export function ToolCallView({ toolCall, className, active = true, compact = false }: ToolCallViewProps) {
  const [expanded, setExpanded] = useState(false)
  const isPending = toolCall.result === undefined && !toolCall.isError
  const isRunning = active && isPending
  const label = getToolLabel(toolCall)
  const searchSources = toolCall.name === 'web_search' ? parseSearchSources(toolCall.result) : []
  const protocolStatus = toolCall.protocol?.status
  const implementation = toolImplementationLabel(toolCall.protocol?.data)

  return (
    <div className={cn('tool-call-item max-w-full', className)}>
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        title={`${toolCall.name} ${label.detail || ''}`}
        className={cn('tool-call-item__trigger flex max-w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-normal transition-colors', !compact && 'text-zinc-500')}
      >
        <ChevronRight
          className={cn('h-3 w-3 transition-transform', compact ? 'text-zinc-500' : 'text-zinc-300', expanded && 'rotate-90')}
        />
        <span className={compact ? 'text-zinc-500' : 'text-zinc-300'}>{getToolIcon(toolCall.name)}</span>
        <span className={cn('text-xs font-normal', !compact && 'text-zinc-500')}>{label.title}</span>
        {!compact && implementation && <span className="shrink-0 text-[10px] text-zinc-400">{implementation}</span>}
        {label.detail && (
          <span className={cn('min-w-0 truncate text-xs', !compact && 'text-zinc-400')} data-tool-detail title={label.detail}>
            {label.detail}
          </span>
        )}
        {label.resultCount !== undefined && !isPending && !toolCall.isError && (
          <span className="rounded-full bg-zinc-200/60 px-1.5 py-0.5 text-xs text-zinc-500">
            {label.resultCount} 个来源
          </span>
        )}
        {(!compact || isPending || toolCall.isError) && <span className="ml-auto">
          {isRunning ? (
            <Loader2 className="h-3 w-3 text-blue-500 animate-spin" />
          ) : toolCall.isError ? (
            <XCircle className="h-3 w-3 text-red-500" />
          ) : isPending ? (
            <CircleDot className="h-3 w-3 text-zinc-400" aria-label="结果未确认" />
          ) : (
            protocolStatus === 'unknown' || protocolStatus === 'dispatched' || protocolStatus === 'applied'
              ? <Wrench className="h-3 w-3 text-amber-500" />
              : <CheckCircle2 className="h-3 w-3 text-green-500" />
          )}
        </span>}
      </button>

      {toolCall.images?.length ? (
        <div className="mt-1.5 ml-4 flex max-w-full flex-wrap gap-2 pb-1">
          {toolCall.images.map((image) => (
            <ReferenceImagePreview
              key={image.path}
              image={image}
              className="h-24 w-24 shrink-0 overflow-hidden rounded-md border border-zinc-200"
            />
          ))}
        </div>
      ) : null}

      {expanded && (
        <div className="tool-call-item__details mt-1.5 ml-4 max-w-[42rem] space-y-2 pl-3 pb-1">
          {compact && implementation && <div className="text-xs text-zinc-400" data-tool-source>{implementation}</div>}
          {toolCall.name === 'web_search' && searchSources.length > 0 ? (
            <>
              <div className="tool-call-detail__query">
                <span>Search</span>
                <strong>{typeof toolCall.arguments.query === 'string' ? toolCall.arguments.query : 'Web query'}</strong>
              </div>
              <ol className="tool-call-sources">
                {searchSources.map((source) => (
                  <li key={`${source.rank}-${source.url}`} className="tool-call-source">
                    <span className="tool-call-source__rank">{source.rank}</span>
                    <div className="min-w-0">
                      {source.url ? (
                        <a href={source.url} target="_blank" rel="noreferrer" className="tool-call-source__title" title={source.title}>
                          <span className="truncate">{source.title}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      ) : (
                        <span className="tool-call-source__title">{source.title}</span>
                      )}
                      {source.host && <div className="tool-call-source__host">{source.host}</div>}
                      {source.snippet && <p className="tool-call-source__snippet">{source.snippet}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          ) : toolCall.name === 'dispatch_tools' && Array.isArray(toolCall.arguments.calls) ? (
            <>
              <div className="text-xs text-zinc-500">本批工具</div>
              <ul className="space-y-1 text-sm text-zinc-600">
                {toolCall.arguments.calls
                  .map(dispatchCallSummary)
                  .filter((summary): summary is string => Boolean(summary))
                  .map((summary, index) => <li key={`${summary}-${index}`}>{summary}</li>)}
              </ul>
              {toolCall.result && (
                <div className={cn('tool-call-result', toolCall.isError && 'tool-call-result--error')}>
                  {toolCall.result}
                </div>
              )}
            </>
          ) : (
            <>
              {Object.keys(toolCall.arguments).length > 0 && (
                <dl className="tool-call-arguments">
                  {Object.entries(toolCall.arguments).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{formatArgumentValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {toolCall.result && (
                <div className={cn('tool-call-result', toolCall.isError && 'tool-call-result--error')}>
                  {toolCall.result}
                </div>
              )}
              {toolCall.protocol && (
                <div className="text-xs text-zinc-500">
                  Protocol: {toolCall.protocol.status} · operation {toolCall.protocol.operationId}
                  {toolCall.protocol.snapshot && ` · snapshot r${toolCall.protocol.snapshot.revision}`}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
