import { useEffect, useMemo, useState } from 'react'
import type { AgentConfig, AgentTokenEstimate, AgentTokenEstimateKind } from '../../../shared/types'
import { BarChart3, ChevronRight, Loader2, RefreshCw, Save } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import { Dialog, DialogClose, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog'
import { EnvironmentRulesPanel } from '@/components/settings/EnvironmentRulesPanel'

const PARTS: Array<{ kind: AgentTokenEstimateKind; label: string; description: string; color: string; track: string }> = [
  { kind: 'system_prompt', label: '系统提示词', description: '当前智能体的专属职责与要求。', color: 'bg-cyan-500', track: 'bg-cyan-50' },
  { kind: 'eva_rules', label: 'Eva 平台规则', description: '通用能力、输出、安全与执行规则。', color: 'bg-violet-500', track: 'bg-violet-50' },
  { kind: 'agent_context', label: '其他智能体配置', description: '模型连接、候选模型和输出偏好等。', color: 'bg-sky-500', track: 'bg-sky-50' },
  { kind: 'tool_instructions', label: '工具说明', description: '已分配工具在系统提示词中的使用说明。', color: 'bg-emerald-500', track: 'bg-emerald-50' },
  { kind: 'tool_schema', label: '工具 Schema', description: '发送给模型的工具参数定义。', color: 'bg-amber-500', track: 'bg-amber-50' },
]

const DEFAULT_PLATFORM_RULES_PLACEHOLDER = '{{default_platform_rules}}'
const SCHEMA_BAR_COLORS = ['bg-violet-500', 'bg-cyan-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-sky-500']

function formatTokens(tokens: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(tokens)
}

export function AgentTokenEstimatePanel({ agent, onUpdate }: { agent: AgentConfig; onUpdate: (updates: Partial<AgentConfig>) => Promise<void> }) {
  const [estimate, setEstimate] = useState<AgentTokenEstimate | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt)
  const [platformTemplate, setPlatformTemplate] = useState(agent.platformPromptTemplate || DEFAULT_PLATFORM_RULES_PLACEHOLDER)
  const [saving, setSaving] = useState(false)
  const [selectedPart, setSelectedPart] = useState<AgentTokenEstimateKind | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setEstimate(await window.eva.agent.estimateTokens(agent.id))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法计算 Token 估算')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [agent.id, agent.systemPrompt, agent.tools])

  useEffect(() => {
    setSystemPrompt(agent.systemPrompt)
    setPlatformTemplate(agent.platformPromptTemplate || DEFAULT_PLATFORM_RULES_PLACEHOLDER)
  }, [agent.id, agent.platformPromptTemplate, agent.systemPrompt])

  const savePrompts = async () => {
    setSaving(true)
    setError(null)
    try {
      await onUpdate({
        systemPrompt,
        systemPromptCustomized: agent.isBuiltIn ? systemPrompt !== agent.systemPrompt || agent.systemPromptCustomized : undefined,
        platformPromptTemplate: platformTemplate.trim() || undefined,
      })
      await load()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '无法保存提示词配置')
    } finally {
      setSaving(false)
    }
  }

  const parts = useMemo(() => PARTS.map((part) => {
    const tokens = estimate?.parts.find((item) => item.kind === part.kind)?.tokens || 0
    if (part.kind === 'system_prompt' && tokens === 0) {
      return {
        ...part,
        description: '未设置专属提示词；Eva 平台规则与工具说明仍会随请求发送。',
        tokens,
        empty: true,
      }
    }
    return { ...part, tokens, empty: false }
  }), [agent.systemPrompt, estimate])

  return (
    <>
    <section className="border-t border-zinc-100 pt-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-violet-600" /><h3 className="text-sm font-semibold text-zinc-900">提示词 Token 估算</h3></div>
          <p className="mt-1 text-sm text-zinc-500">仅计算当前智能体的静态配置，不包含对话历史、用户输入、工具结果或图片。</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} title="重新计算" aria-label="重新计算 Token 估算" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-violet-700 disabled:opacity-50">
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {loading && !estimate ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin text-violet-500" />正在计算当前配置...</div>
      ) : error ? (
        <p className="mt-4 text-sm text-rose-600">{error}</p>
      ) : estimate ? (
        <div className="mt-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3">
              <p className="text-xs text-zinc-500">静态输入合计</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{formatTokens(estimate.totalTokens)} <span className="text-sm font-medium text-zinc-500">tokens</span></p>
            </div>
            <div className="rounded-md border border-violet-100 bg-violet-50/50 px-4 py-3">
              <p className="text-xs text-violet-700">已分配工具</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-violet-900">{agent.tools.length}</p>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {parts.map((part) => {
              const percent = estimate.totalTokens ? (part.tokens / estimate.totalTokens) * 100 : 0
              return (
                <button key={part.kind} type="button" onClick={() => setSelectedPart(part.kind)} className="block w-full rounded-md px-1 py-1 text-left transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
                  <div className="flex items-baseline justify-between gap-4 text-xs">
                    <div className="flex min-w-0 items-center"><span className="font-medium text-zinc-700">{part.label}</span><span className="ml-2 text-zinc-400">{part.description}</span></div>
                    <span className="flex shrink-0 items-center gap-1 tabular-nums text-zinc-600">{part.empty ? '未设置' : `${formatTokens(part.tokens)} tokens`} · {percent.toFixed(1)}%<ChevronRight className="h-3.5 w-3.5 text-zinc-400" /></span>
                  </div>
                  <div className={cn('mt-1.5 h-2 overflow-hidden rounded-sm', part.track)}><div className={cn('h-full rounded-sm transition-[width] duration-300', part.color)} style={{ width: `${percent}%` }} /></div>
                </button>
              )
            })}
          </div>

        </div>
      ) : null}
    </section>

    <Dialog open={selectedPart !== null} onOpenChange={(open) => { if (!open) setSelectedPart(null) }} className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>{PARTS.find((part) => part.kind === selectedPart)?.label || '提示词配置'}</DialogTitle>
        <DialogDescription>查看当前生效内容；可编辑的部分会在保存后立即用于后续请求。</DialogDescription>
      </DialogHeader>
      <DialogClose onClose={() => setSelectedPart(null)} />

      {selectedPart === 'system_prompt' && (
        <div>
          <EnvironmentRulesPanel embedded onSaved={() => void load()} />
          <label className="text-sm font-medium text-zinc-800">专属系统提示词</label>
          <p className="mt-1 text-sm leading-6 text-zinc-500">定义该智能体的角色、边界和专属输出要求。内置智能体的自定义内容会保留，不会在启动时被默认配置覆盖。</p>
          <Textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={14} className="mt-3 font-mono text-xs" placeholder="为该智能体补充专属职责、边界和输出要求" />
          <div className="mt-4 flex justify-end"><Button size="sm" onClick={() => void savePrompts()} disabled={saving} className="gap-1.5"><Save className="h-3.5 w-3.5" />{saving ? '保存中...' : '保存'}</Button></div>
        </div>
      )}

      {selectedPart === 'eva_rules' && (
        <div>
          <label className="text-sm font-medium text-zinc-800">当前 Eva 平台规则</label>
          <p className="mt-1 text-sm leading-6 text-zinc-500">以下内容就是统计中这部分 Token 对应的默认规则。</p>
          <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-zinc-50 p-3 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-zinc-600">{estimate?.evaRulesPreview}</pre>
          <label className="mt-5 block text-sm font-medium text-zinc-800">覆盖模板</label>
          <p className="mt-1 text-sm leading-6 text-zinc-500">保留 <code className="rounded bg-zinc-100 px-1 py-0.5">{DEFAULT_PLATFORM_RULES_PLACEHOLDER}</code> 可继续注入上方的默认规则、工具说明和环境信息。可在占位符前后增加你的规则；删除它才会完全覆盖默认内容。</p>
          <Textarea value={platformTemplate} onChange={(event) => setPlatformTemplate(event.target.value)} rows={8} className="mt-3 font-mono text-xs" />
          <div className="mt-4 flex justify-end"><Button size="sm" onClick={() => void savePrompts()} disabled={saving} className="gap-1.5"><Save className="h-3.5 w-3.5" />{saving ? '保存中...' : '保存'}</Button></div>
        </div>
      )}

      {selectedPart === 'agent_context' && (
        <div>
          <p className="text-sm leading-6 text-zinc-500">这部分来自模型访问、候选模型和输出偏好。请在当前智能体详情页的“模型访问”和“输出格式”中修改。</p>
          <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-zinc-50 p-3 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-zinc-600">{JSON.stringify({ providerId: agent.providerId, model: agent.model, modelCandidates: agent.modelCandidates || [], outputFormat: agent.outputFormat || 'default', outputFormatInstructions: agent.outputFormatInstructions || '' }, null, 2)}</pre>
        </div>
      )}

      {selectedPart === 'tool_instructions' && (
        <div>
          <p className="text-sm leading-6 text-zinc-500">工具说明由当前已分配的工具自动生成。可在当前详情页的“工具访问”中增删工具。</p>
          <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-zinc-50 p-3 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-zinc-600">{estimate?.toolInstructionsPreview || '未分配工具。'}</pre>
        </div>
      )}

      {selectedPart === 'tool_schema' && (
        <div>
          <p className="text-sm leading-6 text-zinc-500">Schema 是工具的实际调用契约，保持只读以避免参数定义与运行时工具实现不一致。</p>
          <div className="mt-4 rounded-md border border-amber-100 bg-amber-50/50 px-4 py-3">
            <p className="text-xs text-amber-800">工具 Schema 合计</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-amber-950">{formatTokens((estimate?.tools || []).reduce((total, tool) => total + tool.tokens, 0))} <span className="text-sm font-medium text-amber-800">tokens</span></p>
          </div>
          <div className="mt-4 max-h-96 space-y-2 overflow-auto pr-1">
            {estimate?.tools.map((tool, index) => {
              const schemaTotal = (estimate?.tools || []).reduce((total, item) => total + item.tokens, 0)
              const schemaPercent = schemaTotal ? (tool.tokens / schemaTotal) * 100 : 0
              return <details key={tool.id} className="rounded-md border border-zinc-200 px-3 py-2"><summary className="cursor-pointer list-none"><div className="flex items-center justify-between gap-3 text-sm"><span className="min-w-0 truncate font-medium text-zinc-700">{tool.label}</span><span className="shrink-0 tabular-nums text-zinc-500">{formatTokens(tool.tokens)} tokens · {schemaPercent.toFixed(1)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-sm bg-zinc-100"><div className={cn('h-full rounded-sm', SCHEMA_BAR_COLORS[index % SCHEMA_BAR_COLORS.length])} style={{ width: `${schemaPercent}%` }} /></div></summary><pre className="mt-3 whitespace-pre-wrap break-words border-t border-zinc-100 pt-3 font-mono text-xs leading-5 text-zinc-600">{tool.schema}</pre></details>
            })}
          </div>
        </div>
      )}

    </Dialog>
    </>
  )
}
