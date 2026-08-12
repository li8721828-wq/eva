import React, { useState } from 'react'
import type { ToolCall } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { ChevronRight, FileCode, Terminal, Search, Loader2, CheckCircle2, XCircle, Wrench, ExternalLink } from 'lucide-react'

function getToolIcon(name: string) {
  if (name.includes('file') || name.includes('read') || name.includes('write'))
    return <FileCode className="h-3.5 w-3.5" />
  if (name.includes('execute') || name.includes('terminal') || name.includes('command'))
    return <Terminal className="h-3.5 w-3.5" />
  if (name.includes('search'))
    return <Search className="h-3.5 w-3.5" />
  return <FileCode className="h-3.5 w-3.5" />
}

function getToolLabel(toolCall: ToolCall): { title: string; detail?: string; resultCount?: number } {
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

export interface ToolCallViewProps {
  toolCall: ToolCall
  className?: string
}

export interface ToolCallGroupViewProps {
  toolCalls: ToolCall[]
  className?: string
}

function operationKey(toolCall: ToolCall): string {
  return `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`
}

export function ToolCallGroupView({ toolCalls, className }: ToolCallGroupViewProps) {
  const [expanded, setExpanded] = useState(false)
  const groupedCalls = Array.from(toolCalls.reduce((groups, toolCall) => {
    const key = operationKey(toolCall)
    const current = groups.get(key)
    if (current) {
      current.count += 1
      if (toolCall.isError || !current.toolCall.result) current.toolCall = toolCall
    } else {
      groups.set(key, { toolCall, count: 1 })
    }
    return groups
  }, new Map<string, { toolCall: ToolCall; count: number }>()).values())
  const repeatedCount = toolCalls.length - groupedCalls.length

  const researchTools = toolCalls.filter((toolCall) => toolCall.name === 'web_search' || toolCall.name === 'read_web_page')
  const isResearchOnly = researchTools.length === toolCalls.length
  const completedCount = toolCalls.filter((toolCall) => Boolean(toolCall.result) && !toolCall.isError).length
  const errorCount = toolCalls.filter((toolCall) => toolCall.isError).length
  const runningCount = toolCalls.length - completedCount - errorCount
  const activeTool = [...toolCalls].reverse().find((toolCall) => !toolCall.result && !toolCall.isError)
  const activeLabel = activeTool ? getToolLabel(activeTool) : null
  const searchCount = toolCalls.filter((toolCall) => toolCall.name === 'web_search').length
  const pageCount = toolCalls.filter((toolCall) => toolCall.name === 'read_web_page').length
  const status = errorCount > 0
    ? `${errorCount} needs attention`
    : runningCount > 0
      ? `${runningCount} in progress`
      : `${completedCount} completed`
  const detail = isResearchOnly
    ? `${toolCalls.length} actions${searchCount ? ` · ${searchCount} searches` : ''}${pageCount ? ` · ${pageCount} pages` : ''}`
    : `${toolCalls.length} actions`
  const displayDetail = repeatedCount > 0
    ? `${groupedCalls.length} unique action${groupedCalls.length === 1 ? '' : 's'} - ${repeatedCount} repeated call${repeatedCount === 1 ? '' : 's'} merged`
    : detail

  return (
    <div className={cn('inline-flex max-w-full flex-col', className)}>
      <button
        onClick={() => setExpanded((value) => !value)}
        className="flex max-w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-zinc-50"
        aria-expanded={expanded}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform', expanded && 'rotate-90')} />
        <span className="text-zinc-500">
          {isResearchOnly ? <Search className="h-3.5 w-3.5" /> : <Wrench className="h-3.5 w-3.5" />}
        </span>
        <span className="text-sm font-medium text-zinc-700">{activeLabel?.title || (isResearchOnly ? 'Research activity' : 'Tool activity')}</span>
        <span className="min-w-0 truncate text-xs text-zinc-500">{activeLabel?.detail || displayDetail}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-zinc-500">
          {activeTool && <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />}
          {status}
        </span>
      </button>

      {expanded && (
        <div className="mt-1.5 ml-4 space-y-1 border-l border-zinc-200 pl-3 pb-1">
          {groupedCalls.map(({ toolCall, count }) => (
            <div key={toolCall.id} className="flex min-w-0 items-start gap-2">
              <ToolCallView toolCall={toolCall} className="min-w-0 flex-1" />
              {count > 1 && <span className="mt-1.5 shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500">x{count}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ToolCallView({ toolCall, className }: ToolCallViewProps) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = !toolCall.result && !toolCall.isError
  const label = getToolLabel(toolCall)
  const searchSources = toolCall.name === 'web_search' ? parseSearchSources(toolCall.result) : []

  return (
    <div className={cn('max-w-full', className)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex max-w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-zinc-50"
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
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="mt-1.5 ml-4 max-w-[42rem] space-y-2 border-l border-zinc-200 pl-3 pb-1">
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
