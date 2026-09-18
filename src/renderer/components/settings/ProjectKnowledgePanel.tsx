import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Bug, Clock3, Compass, RefreshCw, Search, Trash2, Wrench, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useAppStore } from '@/stores/use-app-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import type { ProjectKnowledgeEntry, ProjectKnowledgeKind, ProjectKnowledgeScope, ProjectKnowledgeStatus } from '../../../shared/types/project-knowledge'

const kindLabels: Record<ProjectKnowledgeKind, string> = {
  bug: 'Bug',
  direction: '项目方向',
  change: '代码改动',
  'regression-guard': '回归守则',
  decision: '工程决策',
}

const statusLabels: Record<ProjectKnowledgeStatus, string> = {
  open: '待处理',
  resolved: '已解决',
  'accepted-risk': '已接受风险',
  superseded: '已被替代',
}

const statusTone: Record<ProjectKnowledgeStatus, string> = {
  open: 'border-amber-200 bg-amber-50 text-amber-700',
  resolved: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  'accepted-risk': 'border-sky-200 bg-sky-50 text-sky-700',
  superseded: 'border-zinc-200 bg-zinc-100 text-zinc-600',
}

function kindIcon(kind: ProjectKnowledgeKind) {
  if (kind === 'bug') return <Bug className="h-3.5 w-3.5" />
  if (kind === 'direction') return <Compass className="h-3.5 w-3.5" />
  if (kind === 'change') return <Wrench className="h-3.5 w-3.5" />
  return <BookOpen className="h-3.5 w-3.5" />
}

export function ProjectKnowledgePanel() {
  const { workspacePath } = useAppStore()
  const { activeWorkspaceId, workspaces } = useWorkspaceStore()
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const scope = useMemo<ProjectKnowledgeScope>(() => ({
    workspaceId: activeWorkspace?.id || undefined,
    workspacePath: activeWorkspace?.path || workspacePath || undefined,
  }), [activeWorkspace?.id, activeWorkspace?.path, workspacePath])
  const projectName = activeWorkspace?.name || activeWorkspace?.path?.split(/[\\/]/).filter(Boolean).pop() || '当前项目'

  const [entries, setEntries] = useState<ProjectKnowledgeEntry[]>([])
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | ProjectKnowledgeKind>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | ProjectKnowledgeStatus>('all')
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!scope.workspaceId && !scope.workspacePath) {
      setEntries([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = query.trim()
        ? await window.eva.projectKnowledge.search(scope, query.trim(), 100)
        : await window.eva.projectKnowledge.list(scope)
      setEntries(result)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [query, scope])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), query.trim() ? 180 : 0)
    return () => window.clearTimeout(timer)
  }, [refresh, query])

  const visibleEntries = useMemo(() => entries.filter((entry) =>
    (kindFilter === 'all' || entry.kind === kindFilter) &&
    (statusFilter === 'all' || entry.status === statusFilter)
  ), [entries, kindFilter, statusFilter])

  const updateStatus = async (entry: ProjectKnowledgeEntry, status: ProjectKnowledgeStatus) => {
    setWorkingId(entry.id)
    try {
      const updated = await window.eva.projectKnowledge.update(scope, entry.id, status)
      if (updated) setEntries((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError))
    } finally {
      setWorkingId(null)
    }
  }

  const remove = async (entry: ProjectKnowledgeEntry) => {
    if (!window.confirm(`删除这条工程记录？\n\n${entry.title}`)) return
    setWorkingId(entry.id)
    try {
      const removed = await window.eva.projectKnowledge.delete(scope, entry.id)
      if (removed) setEntries((current) => current.filter((item) => item.id !== entry.id))
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError))
    } finally {
      setWorkingId(null)
    }
  }

  return (
    <section className="mx-auto w-full max-w-6xl space-y-5" aria-label="项目工程记录">
      <header className="flex flex-col gap-4 border-b border-[var(--ui-border)] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900"><BookOpen className="h-4 w-4 text-violet-600" />工程问题记录</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-500">记录当前项目的 bug、用户方向、改动和回归守则。新对话会自动检索相关记录作为参考。</p>
          <p className="mt-2 truncate text-xs text-zinc-400" title={activeWorkspace?.path || workspacePath || '尚未选择项目'}>当前项目：{projectName} · {activeWorkspace?.path || workspacePath || '尚未选择项目'}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => void refresh()} disabled={loading} title="刷新工程记录"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新</Button>
      </header>

      <div className="grid gap-2.5">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="搜索问题、根因、文件或回归守则" aria-label="搜索工程记录" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="min-w-0">
            <span className="mb-1 block text-[11px] font-medium text-zinc-400">类型</span>
            <Select className="w-full" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)} aria-label="按类型筛选" options={[{ value: 'all', label: '全部类型' }, ...Object.entries(kindLabels).map(([value, label]) => ({ value, label }))]} />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[11px] font-medium text-zinc-400">状态</span>
            <Select className="w-full" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} aria-label="按状态筛选" options={[{ value: 'all', label: '全部状态' }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))]} />
          </label>
        </div>
      </div>

      {error && <div role="alert" className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><XCircle className="h-4 w-4 shrink-0" />{error}<Button variant="outline" size="sm" className="ml-auto" onClick={() => void refresh()}>重试</Button></div>}

      {!loading && !visibleEntries.length && <div className="rounded-md border border-dashed border-zinc-300 px-6 py-12 text-center"><BookOpen className="mx-auto h-7 w-7 text-zinc-300" /><p className="mt-3 text-sm text-zinc-600">{scope.workspaceId || scope.workspacePath ? query || kindFilter !== 'all' || statusFilter !== 'all' ? '没有符合筛选条件的工程记录。' : '当前项目还没有工程问题记录。' : '请先选择一个项目。'}</p><p className="mt-1 text-xs text-zinc-400">完成一次 bug 修复或明确项目方向后，记录会自动出现在这里。</p></div>}

      {loading && <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500"><RefreshCw className="h-4 w-4 animate-spin" />正在加载工程记录...</div>}

      {!loading && visibleEntries.length > 0 && <div className="space-y-3">
        <div className="flex items-center justify-between text-xs text-zinc-400"><span>显示 {visibleEntries.length} 条记录</span><span>历史记录仅作参考，修改前仍需检查当前代码</span></div>
        {visibleEntries.map((entry) => (
          <article key={entry.id} className="rounded-md border border-zinc-200 bg-white px-4 py-4 shadow-[0_8px_24px_-22px_rgba(79,70,229,0.6)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500"><span className="flex items-center gap-1 text-violet-600">{kindIcon(entry.kind)}{kindLabels[entry.kind]}</span><span className={`rounded-full border px-2 py-0.5 ${statusTone[entry.status]}`}>{statusLabels[entry.status]}</span><span>{new Date(entry.updatedAt).toLocaleString()}</span></div>
                <h3 className="mt-2 text-sm font-semibold leading-5 text-zinc-900">{entry.title}</h3>
              </div>
              <Button variant="ghost" size="icon" className="shrink-0" title="删除工程记录" aria-label={`删除工程记录：${entry.title}`} disabled={workingId === entry.id} onClick={() => void remove(entry)}><Trash2 className="h-4 w-4 text-zinc-400" /></Button>
            </div>

            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-zinc-700">{entry.summary}</p>
            <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-zinc-100 pt-3 text-xs leading-5 sm:grid-cols-2">
              {entry.symptoms && <div><dt className="font-medium text-zinc-700">现象</dt><dd className="mt-0.5 whitespace-pre-wrap text-zinc-500">{entry.symptoms}</dd></div>}
              {entry.rootCause && <div><dt className="font-medium text-zinc-700">根因</dt><dd className="mt-0.5 whitespace-pre-wrap text-zinc-500">{entry.rootCause}</dd></div>}
              {entry.resolution && <div><dt className="font-medium text-zinc-700">处理结果</dt><dd className="mt-0.5 whitespace-pre-wrap text-zinc-500">{entry.resolution}</dd></div>}
              {entry.verification && <div><dt className="font-medium text-zinc-700">验证</dt><dd className="mt-0.5 whitespace-pre-wrap text-zinc-500">{entry.verification}</dd></div>}
              {entry.affectedFiles.length > 0 && <div className="sm:col-span-2"><dt className="font-medium text-zinc-700">涉及文件</dt><dd className="mt-0.5 break-words font-mono text-zinc-500">{entry.affectedFiles.join(' · ')}</dd></div>}
              {entry.regressionGuard && <div className="sm:col-span-2"><dt className="font-medium text-zinc-700">回归守则</dt><dd className="mt-0.5 whitespace-pre-wrap text-zinc-500">{entry.regressionGuard}</dd></div>}
            </dl>
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-3">
              <label className="flex items-center gap-2 text-xs text-zinc-500"><Clock3 className="h-3.5 w-3.5" />状态<select value={entry.status} disabled={workingId === entry.id} onChange={(event) => void updateStatus(entry, event.target.value as ProjectKnowledgeStatus)} className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 focus:border-violet-500 focus:outline-none">{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              {entry.tags.length > 0 && <span className="text-xs text-zinc-400">标签：{entry.tags.join(' · ')}</span>}
            </div>
          </article>
        ))}
      </div>}
    </section>
  )
}
