import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityCategory, ActivityLogEntry } from '../../../shared/types/activity'
import type { AgentConfig } from '../../../shared/types/agent'
import type { ModelPool } from '../../../shared/types/model-pool'
import type { InstalledPlugin } from '../../../shared/types/plugin'
import type { ProviderConfigEntry } from '../../../shared/types/provider'
import type { RuntimeEvolutionProposal } from '../../../shared/types/runtime-evolution'
import type { RuntimeKernelAuditRecord, RuntimeKernelSnapshot } from '../../../shared/types/runtime-kernel'
import { Activity, AlertTriangle, Bot, Boxes, CheckCircle2, CircleDotDashed, Cpu, Puzzle, RefreshCw, ShieldCheck, Wrench, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { summarizeRuntimeActivity } from '@/lib/runtime-introspection'

type RuntimeData = {
  agents: AgentConfig[]
  plugins: InstalledPlugin[]
  providers: ProviderConfigEntry[]
  pools: ModelPool[]
  activity: ActivityLogEntry[]
  proposals: RuntimeEvolutionProposal[]
  kernel: RuntimeKernelSnapshot | null
  audit: RuntimeKernelAuditRecord[]
}

const emptyRuntime: RuntimeData = { agents: [], plugins: [], providers: [], pools: [], activity: [], proposals: [], kernel: null, audit: [] }

const categoryLabels: Record<ActivityCategory, string> = {
  agent: '智能体', tool: '工具', file: '文件', terminal: '终端', permission: '权限', conversation: '对话', system: '系统',
}

function Metric({ label, value, detail, tone = 'neutral' }: { label: string; value: number; detail: string; tone?: 'neutral' | 'success' | 'warning' | 'error' }) {
  const colors = {
    neutral: 'border-zinc-200 bg-white text-zinc-800',
    success: 'border-emerald-100 bg-emerald-50/60 text-emerald-800',
    warning: 'border-amber-100 bg-amber-50/60 text-amber-800',
    error: 'border-red-100 bg-red-50/60 text-red-800',
  }
  return <div className={cn('min-h-[94px] rounded-md border px-4 py-3', colors[tone])}><p className="text-xs font-medium text-zinc-500">{label}</p><p className="mt-1 text-2xl font-semibold leading-none">{value}</p><p className="mt-2 text-xs text-zinc-500">{detail}</p></div>
}

function ActivityStatus({ status }: Pick<ActivityLogEntry, 'status'>) {
  if (status === 'success') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
  if (status === 'error') return <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
  return <CircleDotDashed className="h-3.5 w-3.5 text-violet-500" />
}

export function RuntimeIntrospectionPanel() {
  const [data, setData] = useState<RuntimeData>(emptyRuntime)
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const refreshInFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setLoading(true)
    setRefreshError(null)
    try {
      const [agents, plugins, providers, pools, activity, proposals, kernel, audit] = await Promise.all([
        window.eva.agent.list(), window.eva.plugins.list(), window.eva.provider.list(), window.eva.modelPool.list(), window.eva.activity.list({ limit: 100 }), window.eva.runtimeProposal.list(), window.eva.runtimeKernel.snapshot(), window.eva.runtimeKernel.listAudit(40),
      ])
      setData({ agents, plugins, providers, pools, activity, proposals, kernel, audit })
      setLastUpdated(Date.now())
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
      refreshInFlight.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
    return window.eva.activity.onEntry((_event, entry) => {
      setData((current) => ({ ...current, activity: [entry, ...current.activity.filter((item) => item.id !== entry.id)].slice(0, 100) }))
      if (entry.action.startsWith('runtime_proposal.')) void refresh()
    })
  }, [refresh])

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const decideProposal = useCallback(async (id: string, status: 'approved' | 'rejected') => {
    setDecidingId(id)
    try {
      await window.eva.runtimeProposal.decide(id, status)
      await refresh()
    } finally {
      setDecidingId(null)
    }
  }, [refresh])

  const summary = useMemo(() => {
    const enabledPlugins = data.plugins.filter((plugin) => plugin.enabled)
    const enabledProviders = data.providers.filter((provider) => provider.isEnabled)
    const routes = data.pools.flatMap((pool) => pool.entries)
    const enabledRoutes = routes.filter((route) => route.enabled)
    const activity = summarizeRuntimeActivity(data.activity)
    return { enabledPlugins, enabledProviders, routes, enabledRoutes, recentErrors: activity.errors, byCategory: activity.byCategory }
  }, [data])

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <header className="flex flex-col gap-4 border-b border-[var(--ui-border)] pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900"><Boxes className="h-4 w-4 text-violet-600" />系统自省</div>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-500">只读查看 Eva 的运行构成、权限面与近期执行证据。敏感凭据、系统提示词、对话内容和文件内容均不会显示。</p>
        </div>
        <div className="flex items-center gap-3"><span className="text-xs text-zinc-400">{lastUpdated ? `更新于 ${new Date(lastUpdated).toLocaleTimeString()}` : '正在加载'}</span><Button variant="outline" size="sm" className="gap-1.5" onClick={() => void refresh()} disabled={loading}><RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />刷新</Button></div>
      </header>

      {refreshError && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">读取运行时状态失败：{refreshError}<Button variant="outline" size="sm" className="ml-3" onClick={() => void refresh()}>重试</Button></div>}

      <section aria-label="Runtime health">
        <div className="mb-3 flex items-center gap-2"><CircleDotDashed className="h-4 w-4 text-violet-600" /><h3 className="text-sm font-semibold text-zinc-800">运行概览</h3></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
          <Metric label="智能体" value={data.agents.length} detail={`${data.agents.filter((agent) => agent.isBuiltIn).length} 个内置`} />
          <Metric label="已启用插件" value={summary.enabledPlugins.length} detail={`共 ${data.plugins.length} 个插件`} tone={data.plugins.length && !summary.enabledPlugins.length ? 'warning' : 'success'} />
          <Metric label="模型连接" value={summary.enabledProviders.length} detail={`共 ${data.providers.length} 个连接`} tone={summary.enabledProviders.length ? 'success' : 'warning'} />
          <Metric label="可用模型路由" value={summary.enabledRoutes.length} detail={`分布在 ${data.pools.length} 个模型池`} tone={summary.enabledRoutes.length ? 'success' : 'warning'} />
          <Metric label="近期异常" value={summary.recentErrors} detail="最近 100 条运行事件" tone={summary.recentErrors ? 'error' : 'success'} />
          <Metric label="Agent OS 活动" value={data.kernel?.activeProcessCount || 0} detail={`${data.kernel?.queuedProcessCount || 0} 个排队`} tone={data.kernel?.activeProcessCount ? 'success' : 'neutral'} />
          <Metric label="资源锁" value={data.kernel?.resourceLocks.length || 0} detail="当前工作区执行锁" tone={data.kernel?.resourceLocks.length ? 'warning' : 'neutral'} />
        </div>
      </section>

      <section aria-label="Agent OS runtime kernel">
        <div className="mb-3 flex items-center gap-2"><Activity className="h-4 w-4 text-violet-600" /><h3 className="text-sm font-semibold text-zinc-800">Agent OS 执行内核</h3><span className="text-xs text-zinc-400">只读状态</span></div>
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
          <div className="overflow-hidden rounded-md border border-[var(--ui-border)] bg-white divide-y divide-zinc-100">
            {data.kernel?.processes.length ? data.kernel.processes.slice(0, 12).map((process) => <div key={process.id} className="flex items-start gap-3 px-4 py-3"><span className={cn('mt-0.5 h-2 w-2 shrink-0 rounded-full', process.status === 'failed' ? 'bg-red-500' : process.status === 'running' ? 'bg-violet-500' : process.status === 'queued' ? 'bg-amber-500' : 'bg-zinc-300')} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-zinc-800">{process.summary || 'Agent OS process'}</strong><span className="eva-status eva-status--neutral">{process.kind}</span><span className="eva-status eva-status--neutral">{process.status}</span></div><p className="mt-1 truncate text-xs text-zinc-500">{process.conversationId} · {new Date(process.updatedAt).toLocaleString()}</p>{process.error && <p className="mt-1 text-xs leading-5 text-red-600">{process.error}</p>}</div></div>) : <p className="px-4 py-6 text-sm text-zinc-500">当前没有 Agent OS 进程。</p>}
          </div>
          <div className="overflow-hidden rounded-md border border-[var(--ui-border)] bg-white divide-y divide-zinc-100">
            {data.audit.length ? data.audit.slice(0, 8).map((entry) => <div key={entry.id} className="px-4 py-3"><div className="flex items-center justify-between gap-3 text-xs"><span className="font-mono text-zinc-500">{entry.kind}</span><span className="text-zinc-400">{new Date(entry.timestamp).toLocaleTimeString()}</span></div><p className="mt-1 text-sm text-zinc-700">{entry.from ? `${entry.from} → ` : ''}{entry.to}</p><p className="mt-1 truncate text-xs text-zinc-500">{entry.detail || '状态已更新'}</p></div>) : <p className="px-4 py-6 text-sm text-zinc-500">尚无 Agent OS 审计记录。</p>}
          </div>
        </div>
      </section>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
        <section aria-label="Agent capability map">
          <div className="mb-3 flex items-center gap-2"><Bot className="h-4 w-4 text-violet-600" /><h3 className="text-sm font-semibold text-zinc-800">智能体与能力</h3></div>
          <div className="overflow-hidden rounded-md border border-[var(--ui-border)] bg-white divide-y divide-zinc-100">
            {data.agents.map((agent) => <div key={agent.id} className="flex items-start gap-3 px-4 py-3"><span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-50 text-violet-600"><Bot className="h-3.5 w-3.5" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-zinc-800">{agent.name}</strong><span className="eva-status eva-status--neutral">{agent.role}</span>{agent.isBuiltIn && <span className="eva-status eva-status--active">内置</span>}</div><p className="mt-1 text-xs text-zinc-500">{agent.providerId} / {agent.model} · {agent.tools.length} 个工具 · {agent.modelPoolIds?.length || 0} 个模型池</p><p className="mt-1 truncate text-xs text-zinc-400">{agent.tools.join(' · ') || '未授权工具'}</p></div></div>)}
          </div>
        </section>

        <section aria-label="Plugin and model routes" className="space-y-6">
          <div><div className="mb-3 flex items-center gap-2"><Puzzle className="h-4 w-4 text-violet-600" /><h3 className="text-sm font-semibold text-zinc-800">插件与权限</h3></div><div className="overflow-hidden rounded-md border border-[var(--ui-border)] bg-white divide-y divide-zinc-100">{data.plugins.length ? data.plugins.map((plugin) => <div key={plugin.id} className="px-4 py-3"><div className="flex items-center justify-between gap-2"><strong className="truncate text-sm text-zinc-800">{plugin.name}</strong><span className={cn('eva-status', plugin.enabled ? 'eva-status--success' : 'eva-status--neutral')}>{plugin.enabled ? '已启用' : '已停用'}</span></div><p className="mt-1 text-xs text-zinc-500">{plugin.permissions.join(' · ') || '无额外权限'}</p></div>) : <p className="px-4 py-5 text-sm text-zinc-500">尚未安装插件。</p>}</div></div>
          <div><div className="mb-3 flex items-center gap-2"><Cpu className="h-4 w-4 text-violet-600" /><h3 className="text-sm font-semibold text-zinc-800">模型路由</h3></div><div className="overflow-hidden rounded-md border border-[var(--ui-border)] bg-white divide-y divide-zinc-100">{summary.routes.length ? summary.routes.map((route) => <div key={route.id} className="flex items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-zinc-800">{route.name}</p><p className="mt-1 truncate text-xs text-zinc-500">{route.providerId} / {route.model} · {route.capabilities.join(', ')}</p></div><span className={cn('eva-status shrink-0', route.enabled ? 'eva-status--success' : 'eva-status--neutral')}>{route.enabled ? `P${route.priority}` : '停用'}</span></div>) : <p className="px-4 py-5 text-sm text-zinc-500">尚未配置模型池路由。</p>}</div></div>
        </section>
      </div>

      <section aria-label="Runtime evolution proposals">
        <div className="mb-3 flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-violet-600" /><h3 className="text-sm font-semibold text-zinc-800">演进提案</h3><span className="eva-status eva-status--neutral">{data.proposals.filter((proposal) => proposal.status === 'draft').length} 待审</span></div>
        <div className="overflow-hidden rounded-md border border-[var(--ui-border)] bg-white divide-y divide-zinc-100">
          {data.proposals.length ? data.proposals.map((proposal) => <div key={proposal.id} className="px-4 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm text-zinc-800">{proposal.title}</strong><span className="eva-status eva-status--neutral">{proposal.area}</span><span className={cn('eva-status', proposal.status === 'approved' ? 'eva-status--success' : proposal.status === 'rejected' ? 'eva-status--neutral' : 'eva-status--active')}>{proposal.status === 'approved' ? '已批准' : proposal.status === 'rejected' ? '已驳回' : '待审'}</span></div><p className="mt-1 text-xs leading-5 text-zinc-500">{proposal.problem}</p><p className="mt-2 text-xs text-zinc-400">建议：{proposal.proposedChanges.slice(0, 2).join('；')}</p></div>{proposal.status === 'draft' && <div className="flex shrink-0 gap-2"><Button variant="outline" size="sm" className="gap-1.5" disabled={decidingId === proposal.id} onClick={() => void decideProposal(proposal.id, 'rejected')}><XCircle className="h-3.5 w-3.5" />驳回</Button><Button size="sm" className="gap-1.5" disabled={decidingId === proposal.id} onClick={() => void decideProposal(proposal.id, 'approved')}><CheckCircle2 className="h-3.5 w-3.5" />批准</Button></div>}</div><p className="mt-3 text-xs text-zinc-400">验证：{proposal.validationPlan.join('；')} · 回滚：{proposal.rollbackPlan.join('；')}</p></div>) : <p className="px-4 py-6 text-sm text-zinc-500">尚无演进提案。</p>}
        </div>
      </section>

      <section aria-label="Activity log">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Wrench className="h-4 w-4 text-violet-600" /><h3 className="text-sm font-semibold text-zinc-800">活动记录</h3></div><div className="flex flex-wrap gap-2">{Object.entries(summary.byCategory).map(([category, count]) => <span key={category} className="eva-status eva-status--neutral">{categoryLabels[category as ActivityCategory]} {count}</span>)}</div></div>
        <div className="overflow-hidden rounded-md border border-[var(--ui-border)] bg-white divide-y divide-zinc-100">{data.activity.length ? data.activity.slice(0, 24).map((entry) => <div key={entry.id} className="flex items-start gap-3 px-4 py-3"><ActivityStatus status={entry.status} /><div className="min-w-0 flex-1"><p className="text-sm text-zinc-700">{entry.summary}</p><p className="mt-1 text-xs text-zinc-400">{categoryLabels[entry.category]} · {entry.action} · {new Date(entry.timestamp).toLocaleString()}</p></div></div>) : <p className="px-4 py-6 text-sm text-zinc-500">尚无运行事件。执行一次对话、任务或工具调用后，此处会自动出现记录。</p>}</div>
      </section>
    </div>
  )
}
