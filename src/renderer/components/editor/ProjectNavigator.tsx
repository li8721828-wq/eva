import { useCallback, useEffect, useMemo, useState } from 'react'
import { Braces, ChevronRight, Database, FileCode2, RefreshCw, Search, Settings2, Tags } from 'lucide-react'
import type {
  ProjectIndexCatalogEntry,
  ProjectIndexCatalogPage,
  ProjectIndexDimension,
  ProjectIndexScope,
  ProjectIndexSearchResult,
  ProjectIndexStatus,
} from '../../../shared/types/project-index'
import type { Conversation } from '../../../shared/types/conversation'
import type { Workspace } from '../../../shared/types/workspace'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'

interface ProjectNavigatorProps {
  workspace: Workspace | null
  conversation: Conversation | null
  onFileSelect: (path: string) => void
  onMultiDimensionalEnabledChange: (enabled: boolean) => Promise<void>
}

const CATALOG_PAGE_SIZE = 80

const DIMENSION_META: Record<ProjectIndexDimension, { label: string; description: string; icon: typeof Braces }> = {
  structure: { label: 'Structure', description: 'Symbols and imports', icon: Braces },
  business: { label: 'Business', description: 'Domain terms', icon: Tags },
  api: { label: 'API surface', description: 'Routes and controllers', icon: FileCode2 },
  data: { label: 'Data layer', description: 'Tables, entities and mappers', icon: Database },
  configuration: { label: 'Configuration', description: 'Settings and keys', icon: Settings2 },
}

function formatIndexedAt(value: number | null): string {
  if (!value) return 'Not indexed yet'
  return `Synced ${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(value)}`
}

function resolveWorkspaceFile(workspace: Workspace, relativePath: string): string {
  const separator = workspace.path.includes('\\') ? '\\' : '/'
  return `${workspace.path.replace(/[\\/]$/, '')}${separator}${relativePath.split('/').join(separator)}`
}

function formatMetric(value: number): string {
  return new Intl.NumberFormat().format(value)
}

function entryDetail(entry: ProjectIndexCatalogEntry): string {
  if (entry.kind === 'term') return `${formatMetric(entry.occurrences || 0)} files`
  const location = entry.relativePath ? `${entry.relativePath}${entry.line ? `:${entry.line}` : ''}` : ''
  return [entry.detail, location].filter(Boolean).join(' - ')
}

export function ProjectNavigator({ workspace, conversation, onFileSelect, onMultiDimensionalEnabledChange }: ProjectNavigatorProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<ProjectIndexStatus | null>(null)
  const [results, setResults] = useState<ProjectIndexSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [updatingPreference, setUpdatingPreference] = useState(false)
  const [catalogScope, setCatalogScope] = useState<ProjectIndexScope>('all')
  const [catalog, setCatalog] = useState<ProjectIndexCatalogPage | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const multiDimensionalEnabled = conversation?.multiDimensionalIndexEnabled !== false

  const hasWorkspace = Boolean(workspace)
  const statusText = useMemo(() => {
    if (!status) return hasWorkspace ? 'Preparing index' : 'Select a project'
    return status.watching ? `Watching - ${formatIndexedAt(status.indexedAt)}` : formatIndexedAt(status.indexedAt)
  }, [hasWorkspace, status])
  const selectedDimension = status?.dimensions.find((dimension) => dimension.scope === catalogScope)

  const loadStatus = useCallback(async (): Promise<void> => {
    if (!workspace) {
      setStatus(null)
      return
    }
    try {
      setStatus(await window.eva.projectIndex.status(workspace.id))
    } catch (error) {
      console.error('Failed to load project index status:', error)
      setStatus(null)
    }
  }, [workspace])

  const loadCatalog = useCallback(async (offset = 0, append = false): Promise<void> => {
    if (!workspace) {
      setCatalog(null)
      return
    }
    setCatalogLoading(true)
    try {
      const page = await window.eva.projectIndex.browse(workspace.id, catalogScope, '', offset, CATALOG_PAGE_SIZE)
      setCatalog((current) => append && current
        ? { ...page, entries: [...current.entries, ...page.entries] }
        : page)
    } catch (error) {
      console.error('Failed to browse project index:', error)
      if (!append) setCatalog(null)
    } finally {
      setCatalogLoading(false)
    }
  }, [catalogScope, workspace])

  useEffect(() => {
    setQuery('')
    setResults([])
    setCatalogScope('all')
    setCatalog(null)
    void loadStatus()
  }, [loadStatus, workspace?.id])

  useEffect(() => {
    if (!workspace || !status || query.trim()) return
    void loadCatalog()
  }, [loadCatalog, query, status, workspace])

  useEffect(() => {
    if (!workspace || !query.trim()) {
      setResults([])
      setLoading(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      setLoading(true)
      // Project navigation always queries the complete index. The per-chat switch only affects Agent tool use.
      void window.eva.projectIndex.search(workspace.id, query.trim(), 20, 'all')
        .then((next) => {
          if (!cancelled) setResults(next)
        })
        .catch((error) => {
          console.error('Failed to search project index:', error)
          if (!cancelled) setResults([])
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, workspace])

  const refresh = async (): Promise<void> => {
    if (!workspace || refreshing) return
    setRefreshing(true)
    try {
      await window.eva.projectIndex.refresh(workspace.id)
      await loadStatus()
      if (query.trim()) setResults(await window.eva.projectIndex.search(workspace.id, query.trim(), 20, 'all'))
      else await loadCatalog()
    } catch (error) {
      console.error('Failed to refresh project index:', error)
    } finally {
      setRefreshing(false)
    }
  }

  const setMultiDimensionalEnabled = async (enabled: boolean): Promise<void> => {
    if (updatingPreference) return
    setUpdatingPreference(true)
    try {
      await onMultiDimensionalEnabledChange(enabled)
    } catch (error) {
      console.error('Failed to update project index preference:', error)
    } finally {
      setUpdatingPreference(false)
    }
  }

  const changeCatalogScope = (scope: ProjectIndexScope): void => {
    if (catalogScope === scope) return
    setCatalogScope(scope)
    setCatalog(null)
  }

  const openCatalogEntry = (entry: ProjectIndexCatalogEntry): void => {
    if (workspace && entry.relativePath) onFileSelect(resolveWorkspaceFile(workspace, entry.relativePath))
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={!hasWorkspace}
            placeholder="Search the complete index"
            className="h-8 rounded-md border-zinc-200 pl-8 text-xs shadow-none"
            aria-label="Search the complete project index"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => void refresh()}
          disabled={!hasWorkspace || refreshing}
          title="Refresh project index"
          aria-label="Refresh project index"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </Button>
      </div>

      <div className="flex items-center gap-1.5 px-4 pb-2 text-[11px] leading-4 text-zinc-400">
        <span className={cn('h-1.5 w-1.5 rounded-full', status?.watching ? 'bg-emerald-500' : 'bg-zinc-300')} />
        <span className="truncate">{statusText}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {!hasWorkspace ? (
          <div className="px-3 py-8 text-center text-xs leading-5 text-zinc-400">Select a project to browse its code.</div>
        ) : loading ? (
          <div className="px-3 py-5 text-xs text-zinc-400">Searching the complete index...</div>
        ) : query.trim() && results.length === 0 ? (
          <div className="px-3 py-5 text-xs text-zinc-400">No indexed matches.</div>
        ) : !query.trim() && status ? (
          <div className="px-2 pt-1">
            <div className="px-2 pb-4 pt-2">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-sm font-medium text-zinc-800">{workspace!.name}</p>
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[10px] font-medium text-zinc-500" title="Only controls whether this conversation's Agent can use multi-dimensional search">
                  <span>Agent uses index</span>
                  <input
                    type="checkbox"
                    checked={multiDimensionalEnabled}
                    onChange={(event) => void setMultiDimensionalEnabled(event.target.checked)}
                    disabled={updatingPreference || !conversation}
                    className="peer sr-only"
                    aria-label="Enable multi-dimensional project index for this conversation's Agent"
                  />
                  <span className="relative h-4 w-7 rounded-full bg-zinc-200 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-violet-500 peer-checked:after:translate-x-3 disabled:opacity-50" />
                </label>
              </div>
              <p className="mt-1 text-[11px] leading-4 text-zinc-400">Complete project metadata, organized across five dimensions.</p>
            </div>

            <div className="grid grid-cols-3 border-y border-zinc-100 py-3">
              {[
                ['Files', status.indexedFiles],
                ['Symbols', status.indexedSymbols],
                ['Imports', status.indexedDependencies],
              ].map(([label, value], index) => (
                <div key={String(label)} className={cn('px-2.5', index > 0 && 'border-l border-zinc-100')}>
                  <p className="text-base font-medium tabular-nums text-zinc-800">{formatMetric(Number(value))}</p>
                  <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-zinc-400">{label}</p>
                </div>
              ))}
            </div>

            <div className="py-4">
              <p className="px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-zinc-400">Index dimensions</p>
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => changeCatalogScope('all')}
                  className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors', catalogScope === 'all' ? 'bg-violet-50 text-violet-700' : 'text-zinc-700 hover:bg-zinc-50')}
                >
                  <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 text-xs font-medium">All records</span>
                  <span className="text-[11px] tabular-nums text-zinc-400">{formatMetric(status.dimensions.reduce((total, item) => total + item.count, 0))}</span>
                </button>
                {status.dimensions.map((dimension) => {
                  const meta = DIMENSION_META[dimension.scope]
                  const Icon = meta.icon
                  const active = catalogScope === dimension.scope
                  return (
                    <button
                      key={dimension.scope}
                      type="button"
                      onClick={() => changeCatalogScope(dimension.scope)}
                      className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors', active ? 'bg-violet-50 text-violet-700' : 'text-zinc-700 hover:bg-zinc-50')}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium">{meta.label}</span>
                        <span className="block truncate pt-0.5 text-[10px] text-zinc-400">{meta.description}</span>
                      </span>
                      <span className="text-[11px] tabular-nums text-zinc-400">{formatMetric(dimension.count)}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="border-t border-zinc-100 px-2 pb-1 pt-4">
              <div className="flex items-baseline justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-zinc-800">{catalogScope === 'all' ? 'Complete index catalog' : DIMENSION_META[catalogScope].label}</p>
                  <p className="mt-1 text-[10px] leading-4 text-zinc-400">
                    {catalogScope === 'all' ? 'Every indexed record, grouped by dimension.' : DIMENSION_META[catalogScope].description}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">{catalog ? formatMetric(catalog.total) : '...'}</span>
              </div>

              {selectedDimension?.samples.length ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {selectedDimension.samples.map((sample) => (
                    <span key={sample} className="max-w-[132px] truncate rounded bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-500">{sample}</span>
                  ))}
                </div>
              ) : null}

              <div className="mt-3">
                {catalog?.entries.map((entry, index) => {
                  const clickable = Boolean(entry.relativePath)
                  const meta = DIMENSION_META[entry.scope]
                  return (
                    <button
                      key={`${entry.scope}-${entry.kind}-${entry.relativePath || 'terms'}-${entry.line || entry.name}-${index}`}
                      type="button"
                      onClick={() => openCatalogEntry(entry)}
                      disabled={!clickable}
                      className={cn(
                        'flex w-full items-start gap-2 border-t border-zinc-100 py-2.5 text-left',
                        clickable ? 'group transition-colors hover:bg-zinc-50' : 'cursor-default'
                      )}
                    >
                      <span className="mt-0.5 w-[52px] shrink-0 text-[9px] font-medium uppercase tracking-[0.06em] text-zinc-400">{meta.label}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-medium text-zinc-700">{entry.name}</span>
                        <span className="mt-0.5 block truncate text-[10px] leading-4 text-zinc-400">{entryDetail(entry)}</span>
                      </span>
                      {clickable ? <ChevronRight className="mt-1 h-3 w-3 shrink-0 text-zinc-300 group-hover:text-violet-500" /> : null}
                    </button>
                  )
                })}
                {catalogLoading && !catalog ? <p className="py-4 text-center text-[11px] text-zinc-400">Loading index records...</p> : null}
                {!catalogLoading && catalog && catalog.entries.length === 0 ? <p className="py-4 text-center text-[11px] text-zinc-400">No records in this dimension.</p> : null}
              </div>
              {catalog?.hasMore ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 h-8 w-full text-xs text-violet-600 hover:text-violet-700"
                  onClick={() => void loadCatalog(catalog.entries.length, true)}
                  disabled={catalogLoading}
                >
                  {catalogLoading ? 'Loading...' : `Show ${Math.min(CATALOG_PAGE_SIZE, catalog.total - catalog.entries.length)} more`}
                </Button>
              ) : null}
            </div>

            {status.languages.length > 0 && (
              <div className="border-t border-zinc-100 px-2 pb-3 pt-5">
                <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-zinc-400">Languages</p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {status.languages.map((item) => (
                    <span key={item.language} className="inline-flex items-center gap-1.5 rounded-full bg-zinc-50 px-2 py-1 text-[11px] text-zinc-600">
                      <span className="max-w-[104px] truncate">{item.language}</span>
                      <span className="tabular-nums text-zinc-400">{formatMetric(item.files)}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : results.map((result) => (
          <button
            key={result.relativePath}
            type="button"
            onClick={() => onFileSelect(resolveWorkspaceFile(workspace!, result.relativePath))}
            className="group flex w-full items-start gap-2 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-zinc-50"
            title={`Open ${result.relativePath}`}
          >
            <FileCode2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400 group-hover:text-violet-500" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-zinc-700">{result.relativePath}</span>
              {(result.symbols.length > 0 || result.dependencies.length > 0) && (
                <span className="mt-1 block truncate text-[11px] leading-4 text-zinc-400">
                  {result.symbols.length > 0 && <><Braces className="mr-1 inline h-3 w-3" />{result.symbols.map((symbol) => symbol.name).join(', ')}</>}
                  {result.symbols.length > 0 && result.dependencies.length > 0 && ' - '}
                  {result.dependencies.length > 0 && `imports ${result.dependencies.map((dependency) => dependency.specifier).join(', ')}`}
                </span>
              )}
              {result.facets.length > 0 && (
                <span className="mt-1 block truncate text-[11px] leading-4 text-violet-500">
                  {result.facets.map((facet) => `${facet.detail ? `${facet.detail} ` : ''}${facet.name}`).join(' - ')}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
