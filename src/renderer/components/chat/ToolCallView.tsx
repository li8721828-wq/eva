import React, { useState } from 'react'
import type { ToolCall } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { ChevronRight, FileCode, Terminal, Search, Loader2, CheckCircle2, XCircle, Wrench, ExternalLink } from 'lucide-react'

function getToolIcon(name: string) {
  if (name === 'dispatch_tools') return <Wrench className="h-3.5 w-3.5" />
  if (name.includes('file') || name.includes('read') || name.includes('write'))
    return <FileCode className="h-3.5 w-3.5" />
  if (name.includes('execute') || name.includes('terminal') || name.includes('command'))
    return <Terminal className="h-3.5 w-3.5" />
  if (name.includes('search'))
    return <Search className="h-3.5 w-3.5" />
  return <FileCode className="h-3.5 w-3.5" />
}

function getToolLabel(toolCall: ToolCall): { title: string; detail?: string; resultCount?: number } {
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

  return { title: toolCall.name }
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

export function ToolCallView({ toolCall, className }: ToolCallViewProps) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = !toolCall.result && !toolCall.isError
  const label = getToolLabel(toolCall)
  const searchSources = toolCall.name === 'web_search' ? parseSearchSources(toolCall.result) : []
  const protocolStatus = toolCall.protocol?.status

  return (
    <div className={cn('tool-call-item max-w-full', className)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="tool-call-item__trigger flex max-w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors"
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 text-zinc-400 transition-transform', expanded && 'rotate-90')}
        />
        <span className="text-zinc-500">{getToolIcon(toolCall.name)}</span>
        <span className="text-sm font-medium text-zinc-700">{label.title}</span>
        {label.detail && (
          <span className="min-w-0 truncate text-xs text-zinc-500" title={label.detail}>
            {label.detail}
          </span>
        )}
        {label.resultCount !== undefined && !isRunning && !toolCall.isError && (
          <span className="rounded-full bg-zinc-200/70 px-1.5 py-0.5 text-[11px] text-zinc-600">
            {label.resultCount} sources
          </span>
        )}
        <span className="ml-auto">
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />
          ) : toolCall.isError ? (
            <XCircle className="h-3.5 w-3.5 text-red-500" />
          ) : (
            protocolStatus === 'unknown' || protocolStatus === 'dispatched' || protocolStatus === 'applied'
              ? <Wrench className="h-3.5 w-3.5 text-amber-500" />
              : <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="tool-call-item__details mt-1.5 ml-4 max-w-[42rem] space-y-2 pl-3 pb-1">
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
