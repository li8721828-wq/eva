import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, Brain, CheckCircle2, Database, RefreshCw, Search, Trash2, UserRound, FolderKanban, Zap, Check, Pencil, RotateCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useAppStore } from '@/stores/use-app-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import type { LongTermMemory, LongTermMemoryKind, LongTermMemoryStatus } from '../../../shared/types/long-term-memory'
import type { PersonalPreferenceSettings } from '../../../shared/types/personal-preferences'

const kindLabels: Record<LongTermMemoryKind, string> = {
  preference: '用户偏好',
  decision: '项目决策',
  fact: '稳定事实',
  bug: '问题记录',
  workflow: '工作方式',
  constraint: '约束规则',
}

const statusLabels: Record<LongTermMemoryStatus, string> = {
  pending: '待确认',
  active: '使用中',
  rejected: '已拒绝',
  superseded: '已替代',
  archived: '已归档',
}

const kindTone: Record<LongTermMemoryKind, string> = {
  preference: 'border-violet-200 bg-violet-50 text-violet-700',
  decision: 'border-sky-200 bg-sky-50 text-sky-700',
  fact: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  bug: 'border-rose-200 bg-rose-50 text-rose-700',
  workflow: 'border-amber-200 bg-amber-50 text-amber-700',
  constraint: 'border-slate-200 bg-slate-100 text-slate-700',
}

function projectScopeId(workspaceId?: string, workspacePath?: string): string | undefined {
  if (workspaceId) return `workspace:${workspaceId}`
  if (workspacePath) return `workspace-path:${workspacePath.replace(/\\/g, '/').toLowerCase()}`
  return undefined
}

function memoryScopeLabel(memory: LongTermMemory, projectName: string): string {
  return memory.scope === 'user' ? '用户记忆' : `项目记忆 · ${projectName}`
}

export function LongTermMemoryPanel() {
  const { workspacePath } = useAppStore()
  const { activeWorkspaceId, workspaces } = useWorkspaceStore()
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const projectName = activeWorkspace?.name || activeWorkspace?.path?.split(/[\\/]/).filter(Boolean).pop() || '当前项目'
  const projectId = projectScopeId(activeWorkspace?.id, activeWorkspace?.path || workspacePath)

  const [memories, setMemories] = useState<LongTermMemory[]>([])
  const [settings, setSettings] = useState<PersonalPreferenceSettings>({ learningEnabled: true, injectionEnabled: true })
  const [scopeFilter, setScopeFilter] = useState<'all' | 'user' | 'project'>('all')
  const [statusFilter, setStatusFilter] = useState<'pending' | 'active' | 'all' | 'archived'>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [workingId, setWorkingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextMemories, nextSettings] = await Promise.all([
        window.eva.longTermMemory.list(),
        window.eva.personalPreferences.getSettings(),
      ])
      setMemories(nextMemories)
      setSettings(nextSettings)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const updateSetting = async (key: keyof PersonalPreferenceSettings, value: boolean) => {
    const next = await window.eva.personalPreferences.saveSettings({ [key]: value })
    setSettings(next)
  }

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

  const beginEdit = (memory: LongTermMemory) => {
    setEditingId(memory.id)
    setDraftTitle(memory.title)
    setDraftContent(memory.content)
  }

  const saveEdit = async (memory: LongTermMemory) => {
    setWorkingId(memory.id)
    try {
      const updated = await window.eva.longTermMemory.update(memory.id, { title: draftTitle, content: draftContent })
      if (updated) setMemories((current) => current.map((item) => item.id === updated.id ? updated : item))
      setEditingId(null)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setWorkingId(null)
    }
  }

  const remove = async (memory: LongTermMemory) => {
    if (!window.confirm(`删除这条长期记忆？\n\n${memory.title}`)) return
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

  const visibleMemories = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return memories.filter((memory) => {
      const inScope = scopeFilter === 'all'
        || (scopeFilter === 'user' && memory.scope === 'user')
        || (scopeFilter === 'project' && memory.scope === 'project' && Boolean(projectId) && memory.scopeId === projectId)
      const inStatus = statusFilter === 'all'
        || (statusFilter === 'active' && memory.status === 'active')
        || (statusFilter === 'pending' && memory.status === 'pending')
        || (statusFilter === 'archived' && (memory.status === 'archived' || memory.status === 'superseded' || memory.status === 'rejected'))
      const matchesQuery = !normalizedQuery || `${memory.title} ${memory.content} ${memory.tags.join(' ')}`.toLocaleLowerCase().includes(normalizedQuery)
      return inScope && inStatus && matchesQuery
    })
  }, [memories, projectId, query, scopeFilter, statusFilter])

  const userCount = memories.filter((memory) => memory.scope === 'user' && memory.status === 'active').length
  // Without a resolved workspace there is no meaningful "current project".
  // Do not turn the dashboard card into a count of every project in storage.
  const projectCount = projectId
    ? memories.filter((memory) => memory.scope === 'project' && memory.status === 'active' && memory.scopeId === projectId).length
    : 0
  const pendingCount = memories.filter((memory) => memory.status === 'pending').length

  return (
    <section className="mx-auto w-full max-w-5xl space-y-5" aria-label="长期记忆">
      <header className="flex flex-col gap-4 border-b border-[var(--ui-border)] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-900"><Brain className="h-4 w-4 text-violet-600" />长期记忆</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-500">统一管理跨项目的用户记忆和当前项目记忆。主 Agent 专注任务，Memory Agent 在后台整理和维护这些记录。</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => void refresh()} disabled={loading} title="刷新长期记忆"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新</Button>
      </header>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="flex items-center justify-between text-violet-600"><UserRound className="h-4 w-4" /><span className="text-2xl font-semibold text-zinc-900">{userCount}</span></div>
          <p className="mt-3 text-sm font-medium text-zinc-800">用户记忆</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">跨项目保留的偏好、沟通方式和工作习惯。</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="flex items-center justify-between text-sky-600"><FolderKanban className="h-4 w-4" /><span className="text-2xl font-semibold text-zinc-900">{projectCount}</span></div>
          <p className="mt-3 text-sm font-medium text-zinc-800">当前项目记忆</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{projectName} 的决策、事实、问题和约束。</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="flex items-center justify-between text-emerald-600"><Zap className="h-4 w-4" /><CheckCircle2 className="h-4 w-4" /></div>
          <p className="mt-3 text-sm font-medium text-zinc-800">Memory Agent</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">后台串行整理，使用当前任务的模型连接，不调用工作区工具。</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="flex items-center justify-between text-amber-600"><Check className="h-4 w-4" /><span className="text-2xl font-semibold text-zinc-900">{pendingCount}</span></div>
          <p className="mt-3 text-sm font-medium text-zinc-800">待确认记忆</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">自动推断的记忆不会直接注入，确认后才会生效。</p>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white">
        <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3"><Database className="h-4 w-4 text-zinc-500" /><h3 className="text-sm font-semibold text-zinc-900">记忆系统配置</h3></div>
        <div className="divide-y divide-zinc-100">
          <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5"><span><span className="block text-sm font-medium text-zinc-800">启用 Memory Agent 整理</span><span className="mt-0.5 block text-xs text-zinc-500">任务完成后分析回合事件，只保存具有长期价值的用户或项目记忆。</span></span><input type="checkbox" checked={settings.learningEnabled} onChange={(event) => void updateSetting('learningEnabled', event.target.checked)} className="h-4 w-4 accent-violet-600" /></label>
          <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5"><span><span className="block text-sm font-medium text-zinc-800">向主 Agent 注入相关记忆</span><span className="mt-0.5 block text-xs text-zinc-500">只注入当前请求相关的用户记忆和项目记忆，并标记为参考资料。</span></span><input type="checkbox" checked={settings.injectionEnabled} onChange={(event) => void updateSetting('injectionEnabled', event.target.checked)} className="h-4 w-4 accent-violet-600" /></label>
          <div className="flex items-center justify-between gap-4 px-4 py-3.5"><span><span className="block text-sm font-medium text-zinc-800">记忆 Agent 模型</span><span className="mt-0.5 block text-xs text-zinc-500">跟随完成当前任务的模型连接，避免额外维护一套模型配置。</span></span><span className="rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600">跟随当前任务</span></div>
        </div>
      </div>

      {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="grid gap-2.5 md:grid-cols-[minmax(0,1fr)_160px_160px]">
        <label className="relative min-w-0"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="搜索记忆标题、内容或标签" aria-label="搜索长期记忆" /></label>
        <Select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value as typeof scopeFilter)} options={[{ value: 'all', label: '全部作用域' }, { value: 'user', label: '用户记忆' }, { value: 'project', label: '当前项目' }]} aria-label="按作用域筛选" />
        <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} options={[{ value: 'all', label: '全部状态' }, { value: 'pending', label: '待确认' }, { value: 'active', label: '使用中的记忆' }, { value: 'archived', label: '已归档或替代' }]} aria-label="按状态筛选" />
      </div>

      {loading && <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500"><RefreshCw className="h-4 w-4 animate-spin" />正在加载长期记忆...</div>}
      {!loading && !visibleMemories.length && <div className="rounded-md border border-dashed border-zinc-300 px-6 py-12 text-center"><Brain className="mx-auto h-7 w-7 text-zinc-300" /><p className="mt-3 text-sm text-zinc-600">没有符合条件的长期记忆。</p><p className="mt-1 text-xs text-zinc-400">完成一次有长期价值的任务后，Memory Agent 会在后台整理记录。</p></div>}
      {!loading && visibleMemories.length > 0 && <div className="space-y-3">
        <div className="flex items-center justify-between text-xs text-zinc-400"><span>显示 {visibleMemories.length} 条记忆</span><span>记忆仅作参考，当前请求和实际代码优先</span></div>
         {visibleMemories.map((memory) => (
           <article key={memory.id} className="rounded-lg border border-zinc-200 bg-white px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500"><span className={`rounded-full border px-2 py-0.5 ${kindTone[memory.kind]}`}>{kindLabels[memory.kind]}</span><span>{memoryScopeLabel(memory, projectName)}</span><span>{statusLabels[memory.status]}</span></div>
                <h3 className="mt-2 text-sm font-semibold leading-5 text-zinc-900">{memory.title}</h3>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {memory.status === 'pending' && <><Button variant="ghost" size="icon" title="确认记忆" aria-label={`确认记忆：${memory.title}`} disabled={workingId === memory.id} onClick={() => void updateStatus(memory, 'active')}><Check className="h-4 w-4 text-emerald-600" /></Button><Button variant="ghost" size="icon" title="拒绝记忆" aria-label={`拒绝记忆：${memory.title}`} disabled={workingId === memory.id} onClick={() => void updateStatus(memory, 'rejected')}><X className="h-4 w-4 text-zinc-400" /></Button></>}
                {(memory.status === 'rejected' || memory.status === 'archived') && <Button variant="ghost" size="icon" title="恢复为待确认" aria-label={`恢复记忆：${memory.title}`} disabled={workingId === memory.id} onClick={() => void updateStatus(memory, 'pending')}><RotateCcw className="h-4 w-4 text-zinc-400" /></Button>}
                {memory.status === 'active' && <Button variant="ghost" size="icon" title="归档记忆" aria-label={`归档记忆：${memory.title}`} disabled={workingId === memory.id} onClick={() => void updateStatus(memory, 'archived')}><Archive className="h-4 w-4 text-zinc-400" /></Button>}
                <Button variant="ghost" size="icon" title="编辑记忆" aria-label={`编辑记忆：${memory.title}`} disabled={workingId === memory.id} onClick={() => beginEdit(memory)}><Pencil className="h-4 w-4 text-zinc-400" /></Button>
                <Button variant="ghost" size="icon" title="删除记忆" aria-label={`删除记忆：${memory.title}`} disabled={workingId === memory.id} onClick={() => void remove(memory)}><Trash2 className="h-4 w-4 text-zinc-400" /></Button>
              </div>
            </div>
            {editingId === memory.id ? (
              <div className="mt-3 grid gap-3">
                <Input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} aria-label="记忆标题" />
                <textarea value={draftContent} onChange={(event) => setDraftContent(event.target.value)} aria-label="记忆内容" className="min-h-24 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm leading-6 text-zinc-700 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500" />
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>取消</Button>
                  <Button size="sm" onClick={() => void saveEdit(memory)} disabled={workingId === memory.id || !draftTitle.trim() || !draftContent.trim()}>保存修改</Button>
                </div>
              </div>
            ) : <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-zinc-700">{memory.content}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-100 pt-3 text-xs text-zinc-400"><span>置信度 {Math.round(memory.confidence * 100)}%</span><span>重要性 {Math.round(memory.importance * 100)}%</span><span>{memory.evidence.length} 条证据</span>{memory.tags.length > 0 && <span>标签：{memory.tags.join(' · ')}</span>}</div>
          </article>
        ))}
      </div>}
    </section>
  )
}
