import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Save, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import type { EnvironmentRule, EnvironmentRuleScope, EnvironmentRulesConfig } from '../../../shared/types/environment-rules'
import { DEFAULT_ENVIRONMENT_RULES } from '../../../shared/types/environment-rules'

const scopeLabels: Record<EnvironmentRuleScope, string> = {
  all: '全部系统',
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
}

const sourceLabels: Record<EnvironmentRule['source'], string> = {
  detected: '系统检测',
  learned: '自动归纳',
  user: '用户规则',
}

function cloneDefaults(): EnvironmentRulesConfig {
  return { ...DEFAULT_ENVIRONMENT_RULES, rules: DEFAULT_ENVIRONMENT_RULES.rules.map((rule) => ({ ...rule })) }
}

export function EnvironmentRulesPanel({ embedded = false, onSaved }: { embedded?: boolean; onSaved?: () => void } = {}) {
  const [config, setConfig] = useState<EnvironmentRulesConfig>(cloneDefaults)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [draftScope, setDraftScope] = useState<EnvironmentRuleScope>('all')

  const approximateTokens = useMemo(() => Math.ceil(config.rules.filter((rule) => rule.enabled).reduce((total, rule) => total + rule.title.length + rule.content.length, 0) / 2.6), [config.rules])

  const load = async () => {
    setLoading(true)
    try {
      const stored = await window.eva.config.get<EnvironmentRulesConfig>('environmentRules')
      setConfig(stored?.rules?.length ? stored : cloneDefaults())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const persist = async (next: EnvironmentRulesConfig) => {
    setConfig(next)
    setSaving(true)
    try {
      await window.eva.config.set('environmentRules', next)
      onSaved?.()
    } finally {
      setSaving(false)
    }
  }

  const resetDraft = () => {
    setEditingId(null)
    setDraftTitle('')
    setDraftContent('')
    setDraftScope('all')
  }

  const edit = (rule: EnvironmentRule) => {
    setEditingId(rule.id)
    setDraftTitle(rule.title)
    setDraftContent(rule.content)
    setDraftScope(rule.scope)
  }

  const saveRule = async () => {
    const title = draftTitle.trim()
    const content = draftContent.trim()
    if (!title || !content) return
    const now = Date.now()
    const nextRule: EnvironmentRule = {
      id: editingId || `environment-rule-${now}`,
      title,
      content,
      scope: draftScope,
      source: editingId ? config.rules.find((rule) => rule.id === editingId)?.source || 'user' : 'user',
      enabled: editingId ? config.rules.find((rule) => rule.id === editingId)?.enabled !== false : true,
      occurrences: editingId ? config.rules.find((rule) => rule.id === editingId)?.occurrences || 1 : 1,
      createdAt: editingId ? config.rules.find((rule) => rule.id === editingId)?.createdAt || now : now,
      updatedAt: now,
    }
    const next = {
      ...config,
      rules: editingId ? config.rules.map((rule) => rule.id === editingId ? nextRule : rule) : [...config.rules, nextRule],
    }
    await persist(next)
    resetDraft()
  }

  return (
    <section className={embedded ? 'mt-6 space-y-5 border-t border-zinc-200 pt-6' : 'mx-auto w-full max-w-6xl space-y-6'}>
      <header className={embedded ? 'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between' : 'flex flex-col gap-3 border-b border-zinc-200 pb-5 sm:flex-row sm:items-start sm:justify-between'}>
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900"><Settings2 className="h-4 w-4 text-violet-600" />共享运行环境系统提示词</div>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-500">这部分属于系统提示词，会随每个智能体的请求发送。自动归纳只保存高置信、可复用的规则，不保存原始报错或文件内容。</p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()} disabled={loading || saving}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新</Button>
      </header>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <div className="rounded-md border border-zinc-200 bg-white px-4 py-3"><p className="text-xs text-zinc-500">当前规则估算</p><p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{approximateTokens} <span className="text-sm font-medium text-zinc-500">tokens</span></p></div>
        <label className="rounded-md border border-violet-100 bg-violet-50/60 px-4 py-3 text-sm text-violet-900"><span className="block text-xs text-violet-700">注入上限</span><Input type="number" min={120} max={1200} value={config.maxTokens} onChange={(event) => void persist({ ...config, maxTokens: Math.max(120, Math.min(1200, Number(event.target.value) || 700)) })} className="mt-1 h-8 border-violet-200 bg-white" /></label>
      </div>

      <label className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700"><span><strong className="font-medium text-zinc-900">启用共享环境规则</strong><span className="ml-2 text-xs text-zinc-500">关闭后不会注入任何智能体。</span></span><input type="checkbox" checked={config.enabled} onChange={(event) => void persist({ ...config, enabled: event.target.checked })} className="h-4 w-4 accent-violet-600" /></label>

      <div className="space-y-2">
        {config.rules.map((rule) => (
          <article key={rule.id} className="rounded-md border border-zinc-200 bg-white px-4 py-3">
            <div className="flex items-start justify-between gap-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium text-zinc-900">{rule.title}</h3><span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600">{scopeLabels[rule.scope]}</span><span className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700">{sourceLabels[rule.source]}</span></div><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-600">{rule.content}</p></div><div className="flex shrink-0 items-center gap-1"><input type="checkbox" checked={rule.enabled} onChange={(event) => void persist({ ...config, rules: config.rules.map((item) => item.id === rule.id ? { ...item, enabled: event.target.checked, updatedAt: Date.now() } : item) })} title="启用规则" className="h-4 w-4 accent-violet-600" /><Button variant="ghost" size="icon" title="编辑规则" onClick={() => edit(rule)}><Save className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" title="删除规则" onClick={() => void persist({ ...config, rules: config.rules.filter((item) => item.id !== rule.id) })}><Trash2 className="h-3.5 w-3.5 text-rose-600" /></Button></div></div>
          </article>
        ))}
      </div>

      <section className="rounded-md border border-zinc-200 bg-zinc-50/70 p-4">
        <div className="flex items-center gap-2"><Plus className="h-4 w-4 text-violet-600" /><h3 className="text-sm font-semibold text-zinc-900">{editingId ? '编辑规则' : '新增规则'}</h3></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]"><Input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} placeholder="规则名称" /><select value={draftScope} onChange={(event) => setDraftScope(event.target.value as EnvironmentRuleScope)} className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-700"><option value="all">全部系统</option><option value="win32">Windows</option><option value="darwin">macOS</option><option value="linux">Linux</option></select></div>
        <Textarea value={draftContent} onChange={(event) => setDraftContent(event.target.value)} rows={4} className="mt-3 bg-white text-sm" placeholder="写入可验证、可复用的环境或工具约定。" />
        <div className="mt-3 flex justify-end gap-2"><Button variant="outline" size="sm" onClick={resetDraft} disabled={!editingId && !draftTitle && !draftContent}>取消</Button><Button size="sm" className="gap-1.5" onClick={() => void saveRule()} disabled={!draftTitle.trim() || !draftContent.trim() || saving}><Save className="h-3.5 w-3.5" />保存规则</Button></div>
      </section>
    </section>
  )
}
