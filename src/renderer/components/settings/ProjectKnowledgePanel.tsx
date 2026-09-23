import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, BookOpen, CheckCircle2, Clock3, RefreshCw, Search, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import type { LongTermMemory, LongTermMemoryKind, LongTermMemoryStatus } from '../../../shared/types/long-term-memory'

const kindLabels: Record<LongTermMemoryKind, string> = {
  preference: '用户偏好',
  decision: '工程决策',
  fact: '项目事实',
  bug: '问题记录',
  workflow: '工作流程',
  constraint: '项目约束',
}

const statusLabels: Record<LongTermMemoryStatus, string> = {
  pending: '待确认',
  active: '已启用',
  rejected: '已拒绝',
  superseded: '已被替代',
  archived: '已归档',
}

const statusTone: Record<LongTermMemoryStatus, string> = {
  pending: 'border-amber-200 bg-amber-50 text-amber-700',
  active: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  rejected: 'border-rose-200 bg-rose-50 text-rose-700',
  superseded: 'border-zinc-200 bg-zinc-100 text-zinc-600',
  archived: 'border-zinc-200 bg-zinc-100 text-zinc-600',
}

function projectScopeId(workspaceId?: string, workspacePath?: string): string | undefined {
  if (workspaceId?.trim()) return `workspace:${workspaceId.trim()}`
  const normalizedPath = workspacePath?.trim().replace(/\\/g, '/').toLowerCase()
  return normalizedPath ? `workspace-path:${normalizedPath}` : undefined
}

export function ProjectKnowledgePanel() {
  const { workspacePath } = useAppStore()
  const { currentConversationId, conversations } = useChatStore()
  const { activeWorkspaceId, workspaces } = useWorkspaceStore()
  const currentConversation = conversations.find((conversation) => conversation.id === currentConversationId)
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const conversationWorkspace = currentConversation?.workspaceId
    ? workspaces.find((workspace) => workspace.id === currentConversation.workspaceId)
    : undefined
  const resolvedWorkspace = conversationWorkspace || activeWorkspace
  const resolvedWorkspacePath = currentConversation?.workspacePath || resolvedWorkspace?.path || workspacePath
  const resolvedWorkspaceId = currentConversation?.workspaceId || resolvedWorkspace?.id
  const scopeId = projectScopeId(resolvedWorkspaceId, resolvedWorkspacePath)
  const projectName = resolvedWorkspace?.name || resolvedWorkspacePath?.split(/[\\/]/).filter(Boolean).pop() || '当前项目'
  const scope = useMemo(() => scopeId ? [{ scope: 'project' as const, scopeId }] : [], [scopeId])

  const [memories, setMemories] = useState<LongTermMemory[]>([])
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | LongTermMemoryKind>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | LongTermMemoryStatus>('all')
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!scopeId) {
      setMemories([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = query.trim()
        ? await window.eva.longTermMemory.search(query.trim(), scope, 100)
        : await window.eva.longTermMemory.list({ scope: 'project', scopeId })
      setMemories(result)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [query, scope, scopeId])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), query.trim() ? 180 : 0)
    return () => window.clearTimeout(timer)
  }, [refresh, query])

  const visibleMemories = useMemo(() => memories.filter((memory) =>
    (kindFilter === 'all' || memory.kind === kindFilter) &&
    (statusFilter === 'all' || memory.status === statusFilter)
  ), [kindFilter, memories, statusFilter])

  const updateStatus = async (memory: LongTermMemory, status: LongTermMemoryStatus) => {
    setWorkingId(memory.id)
    try {
      const updated = await window.eva.longTermMemory.update(memory.id, { status })
      if (updated) setMemories((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError))
    } finally {
      setWorkingId(null)
    }
  }

  const remove = async (memory: LongTermMemory) => {
    if (!window.confirm(`删除这条项目长期记忆？\n\n${memory.title}`)) return
    setWorkingId(memory.id)
    try {
      const removed = await window.eva.longTermMemory.delete(memory.id)
      if (removed) setMemories((current) => current.filter((item) => item.id !== memory.id))
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError))
    } finally {
      setWorkingId(null)
    }
  }

  return (
    <section className="mx-auto w-full max-w-6xl space-y-5" aria-label="项目长期记忆">
      <header className="flex flex-col gap-4 border-b border-[var(--ui-border)] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900"><BookOpen className="h-4 w-4 text-violet-600" />项目长期记忆</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-500">这里显示当前项目作用域的统一长期记忆，包括项目事实、决策、问题和约束。</p>
          <p className="mt-2 truncate text-xs text-zinc-400" title={resolvedWorkspacePath || '尚未选择项目'}>当前项目：{projectName} · {resolvedWorkspacePath || '尚未选择项目'}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => void refresh()} disabled={loading} title="刷新项目长期记忆"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新</Button>
      </header>

      <div className="grid gap-2.5">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="搜索标题、内容或标签" aria-label="搜索项目长期记忆" />
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

      {!loading && !visibleMemories.length && <div className="rounded-md border border-dashed border-zinc-300 px-6 py-12 text-center"><BookOpen className="mx-auto h-7 w-7 text-zinc-300" /><p className="mt-3 text-sm text-zinc-600">{scopeId ? query || kindFilter !== 'all' || statusFilter !== 'all' ? '没有符合筛选条件的项目长期记忆。' : '当前项目还没有长期记忆。' : '请先选择一个项目。'}</p><p className="mt-1 text-xs text-zinc-400">完成有长期价值的项目任务后，Memory Agent 会在后台整理记录。</p></div>}

      {loading && <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500"><RefreshCw className="h-4 w-4 animate-spin" />正在加载项目长期记忆...</div>}

      {!loading && visibleMemories.length > 0 && <div className="space-y-3">
        <div className="flex items-center justify-between text-xs text-zinc-400"><span>显示 {visibleMemories.length} 条记忆</span><span>仅展示当前项目作用域</span></div>
        {visibleMemories.map((memory) => (
          <article key={memory.id} className="rounded-md border border-zinc-200 bg-white px-4 py-4 shadow-[0_8px_24px_-22px_rgba(79,70,229,0.6)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500"><span className="text-violet-600">{kindLabels[memory.kind]}</span><span className={`rounded-full border px-2 py-0.5 ${statusTone[memory.status]}`}>{statusLabels[memory.status]}</span><span>{new Date(memory.updatedAt).toLocaleString()}</span></div>
                <h3 className="mt-2 text-sm font-semibold leading-5 text-zinc-900">{memory.title}</h3>
              </div>
              <Button variant="ghost" size="icon" className="shrink-0" title="删除项目长期记忆" aria-label={`删除项目长期记忆：${memory.title}`} disabled={workingId === memory.id} onClick={() => void remove(memory)}><Trash2 className="h-4 w-4 text-zinc-400" /></Button>
            </div>

            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-zinc-700">{memory.content}</p>
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-3">
              <label className="flex items-center gap-2 text-xs text-zinc-500"><Clock3 className="h-3.5 w-3.5" />状态<select value={memory.status} disabled={workingId === memory.id} onChange={(event) => void updateStatus(memory, event.target.value as LongTermMemoryStatus)} className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 focus:border-violet-500 focus:outline-none">{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              {memory.status === 'pending' && <Button variant="outline" size="sm" className="gap-1.5" disabled={workingId === memory.id} onClick={() => void updateStatus(memory, 'active')}><CheckCircle2 className="h-3.5 w-3.5" />确认</Button>}
              {memory.status === 'active' && <Button variant="ghost" size="sm" className="gap-1.5 text-zinc-500" disabled={workingId === memory.id} onClick={() => void updateStatus(memory, 'archived')}><Archive className="h-3.5 w-3.5" />归档</Button>}
              {memory.tags.length > 0 && <span className="text-xs text-zinc-400">标签：{memory.tags.join(' · ')}</span>}
              <span className="ml-auto text-xs text-zinc-400">置信度 {Math.round(memory.confidence * 100)}% · 重要性 {Math.round(memory.importance * 100)}%</span>
            </div>
          </article>
        ))}
      </div>}
    </section>
  )
}
