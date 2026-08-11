import React, { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BarChart3, Coins, Database, Plus, RefreshCw, Save, Trash2, Zap } from 'lucide-react'
import type { CostUsageRecord, CostUsageReport, ModelRateCard } from '../../../shared/types/cost'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/use-app-store'
import { uiCopy } from '@/lib/ui-copy'

type Range = '7d' | '30d' | '90d' | 'all'
type Granularity = 'day' | 'week' | 'month'

const RANGE_OPTIONS = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
]

const GRANULARITY_OPTIONS = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
]

function cny(value: number | undefined): string {
  if (value === undefined) return '--'
  return `¥${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
}

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

function rangeStart(range: Range): number {
  if (range === 'all') return 0
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  return Date.now() - days * 24 * 60 * 60 * 1000
}

function bucketKey(timestamp: number, granularity: Granularity): string {
  const date = new Date(timestamp)
  if (granularity === 'month') return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  if (granularity === 'week') {
    const weekStart = new Date(date)
    weekStart.setDate(date.getDate() - ((date.getDay() + 6) % 7))
    return `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function TrendChart({ records, granularity }: { records: CostUsageRecord[]; granularity: Granularity }) {
  const points = useMemo(() => {
    const buckets = new Map<string, { cost: number; tokens: number }>()
    for (const record of records) {
      const key = bucketKey(record.timestamp, granularity)
      const current = buckets.get(key) || { cost: 0, tokens: 0 }
      current.cost += record.estimatedCostCny || 0
      current.tokens += record.promptTokens + record.completionTokens
      buckets.set(key, current)
    }
    return Array.from(buckets.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([label, value]) => ({ label, ...value }))
  }, [granularity, records])
  const maxCost = Math.max(0.01, ...points.map((point) => point.cost))
  const width = 760
  const height = 250
  const left = 54
  const right = 20
  const top = 22
  const bottom = 42
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const x = (index: number) => points.length <= 1 ? left + plotWidth / 2 : left + (index / (points.length - 1)) * plotWidth
  const y = (value: number) => top + plotHeight - (value / maxCost) * plotHeight
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(point.cost)}`).join(' ')
  const ticks = [0, 0.5, 1]

  if (points.length === 0) return <div className="flex h-[250px] items-center justify-center text-sm text-zinc-400">No usage in the selected period.</div>

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Estimated cost trend" className="h-[250px] w-full overflow-visible">
      <title>Estimated cost trend</title>
      {ticks.map((tick) => <g key={tick}><line x1={left} x2={width - right} y1={y(maxCost * tick)} y2={y(maxCost * tick)} className="stroke-zinc-200" /><text x={left - 8} y={y(maxCost * tick) + 4} textAnchor="end" className="fill-zinc-400 text-[11px]">{cny(maxCost * tick)}</text></g>)}
      <path d={`${line} L ${x(points.length - 1)} ${top + plotHeight} L ${x(0)} ${top + plotHeight} Z`} className="fill-violet-100/80" />
      <path d={line} fill="none" className="stroke-violet-600" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((point, index) => <g key={point.label}><circle cx={x(index)} cy={y(point.cost)} r="3.5" className="fill-violet-600" /><title>{`${point.label}: ${cny(point.cost)} · ${tokens(point.tokens)} tokens`}</title></g>)}
      {points.filter((_, index) => index === 0 || index === points.length - 1 || (points.length <= 6 && index % 1 === 0)).map((point, index, list) => {
        const originalIndex = points.indexOf(point)
        return <text key={`${point.label}-axis`} x={x(originalIndex)} y={height - 15} textAnchor={originalIndex === 0 ? 'start' : originalIndex === points.length - 1 ? 'end' : 'middle'} className="fill-zinc-400 text-[11px]">{list.length > 4 ? point.label.slice(5) : point.label}</text>
      })}
    </svg>
  )
}

export function CostCenter() {
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const language = useAppStore((state) => state.language)
  const copy = uiCopy[language].cost
  const [report, setReport] = useState<CostUsageReport | null>(null)
  const [range, setRange] = useState<Range>('30d')
  const [granularity, setGranularity] = useState<Granularity>('day')
  const [providerId, setProviderId] = useState('all')
  const [loading, setLoading] = useState(true)
  const [savingRates, setSavingRates] = useState(false)
  const [rateCards, setRateCards] = useState<ModelRateCard[]>([])
  const [error, setError] = useState<string | null>(null)

  const loadReport = async () => {
    setLoading(true)
    try {
      const next = await window.eva.cost.getUsageReport()
      setReport(next)
      setRateCards(next.rateCards)
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load cost data.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadReport() }, [])

  const providers = useMemo(() => Array.from(new Map((report?.records || []).map((record) => [record.providerId, record.providerName])).entries()), [report])
  const visibleRecords = useMemo(() => (report?.records || []).filter((record) => record.timestamp >= rangeStart(range) && (providerId === 'all' || record.providerId === providerId)), [providerId, range, report])
  const totals = useMemo(() => visibleRecords.reduce((total, record) => ({
    cost: total.cost + (record.estimatedCostCny || 0),
    priced: total.priced + (record.estimatedCostCny === undefined ? 0 : 1),
    prompt: total.prompt + record.promptTokens,
    completion: total.completion + record.completionTokens,
    cached: total.cached + record.cachedTokens,
    calls: total.calls + record.modelCalls,
  }), { cost: 0, priced: 0, prompt: 0, completion: 0, cached: 0, calls: 0 }), [visibleRecords])
  const cacheRate = totals.prompt > 0 ? totals.cached / totals.prompt : 0
  const rangeOptions = [
    { value: '7d', label: copy.last7 },
    { value: '30d', label: copy.last30 },
    { value: '90d', label: copy.last90 },
    { value: 'all', label: copy.allTime },
  ]
  const granularityOptions = [
    { value: 'day', label: copy.daily },
    { value: 'week', label: copy.weekly },
    { value: 'month', label: copy.monthly },
  ]
  const breakdown = useMemo(() => {
    const rows = new Map<string, { providerName: string; model: string; cost: number; priced: number; prompt: number; completion: number; cached: number; calls: number }>()
    for (const record of visibleRecords) {
      const key = `${record.providerId}:${record.model}`
      const current = rows.get(key) || { providerName: record.providerName, model: record.model, cost: 0, priced: 0, prompt: 0, completion: 0, cached: 0, calls: 0 }
      current.cost += record.estimatedCostCny || 0
      current.priced += record.estimatedCostCny === undefined ? 0 : 1
      current.prompt += record.promptTokens
      current.completion += record.completionTokens
      current.cached += record.cachedTokens
      current.calls += record.modelCalls
      rows.set(key, current)
    }
    return Array.from(rows.values()).sort((left, right) => right.cost - left.cost || right.prompt + right.completion - (left.prompt + left.completion))
  }, [visibleRecords])

  const updateRate = (id: string, updates: Partial<ModelRateCard>) => setRateCards((current) => current.map((rate) => rate.id === id ? { ...rate, ...updates, updatedAt: Date.now() } : rate))
  const addRate = () => setRateCards((current) => [...current, { id: `rate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, providerId: providers[0]?.[0] || '', model: '', inputCnyPerMillion: 0, cachedInputCnyPerMillion: 0, outputCnyPerMillion: 0, updatedAt: Date.now() }])
  const removeRate = (id: string) => setRateCards((current) => current.filter((rate) => rate.id !== id))
  const saveRates = async () => {
    setSavingRates(true)
    try {
      await window.eva.cost.saveRateCards(rateCards)
      await loadReport()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save rate cards.')
    } finally {
      setSavingRates(false)
    }
  }

  return (
    <div className="cost-center flex h-full min-h-0 flex-col overflow-auto">
      <header className="cost-header flex flex-wrap items-start justify-between gap-4 border-b px-7 py-5">
        <div><div className="flex items-center gap-2"><Coins className="h-5 w-5 text-violet-600" /><h1 className="text-lg font-semibold text-zinc-900">{copy.title}</h1></div><p className="mt-1 text-sm text-zinc-500">{copy.subtitle}</p></div>
        <div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => setCurrentView('chat')}><ArrowLeft className="mr-1.5 h-3.5 w-3.5" />{copy.back}</Button><Button variant="outline" size="sm" onClick={() => void loadReport()} disabled={loading}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />{copy.refresh}</Button></div>
      </header>

      <main className="cost-content mx-auto flex w-full max-w-7xl flex-col gap-6 px-7 py-6">
        <div className="cost-filters flex flex-wrap items-end gap-3 pb-5">
          <div className="w-40"><label className="mb-1.5 block text-xs font-medium text-zinc-600">{copy.timePeriod}</label><Select value={range} onChange={(event) => setRange(event.target.value as Range)} options={rangeOptions} /></div>
          <div className="w-36"><label className="mb-1.5 block text-xs font-medium text-zinc-600">{copy.aggregation}</label><Select value={granularity} onChange={(event) => setGranularity(event.target.value as Granularity)} options={granularityOptions} /></div>
          <div className="min-w-48 flex-1"><label className="mb-1.5 block text-xs font-medium text-zinc-600">{copy.supplier}</label><Select value={providerId} onChange={(event) => setProviderId(event.target.value)} options={[{ value: 'all', label: copy.allSuppliers }, ...providers.map(([id, name]) => ({ value: id, label: name }))]} /></div>
          {error && <p className="pb-2 text-sm text-red-600">{error}</p>}
        </div>

        <section className="cost-metrics grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={Coins} label={copy.estimatedCost} value={cny(totals.cost)} detail={totals.priced === visibleRecords.length ? copy.allRecordsPriced : `${totals.priced}/${visibleRecords.length} ${copy.recordsPriced}`} />
          <Metric icon={Zap} label={copy.modelCalls} value={totals.calls.toLocaleString()} detail={`${visibleRecords.length} ${copy.usageRecords}`} />
          <Metric icon={BarChart3} label="Token volume" value={tokens(totals.prompt + totals.completion)} detail={`Input ${tokens(totals.prompt)} · Output ${tokens(totals.completion)}`} />
          <Metric icon={Database} label={copy.cacheHitRate} value={`${(cacheRate * 100).toFixed(1)}%`} detail={`${tokens(totals.cached)} ${copy.cachedInputTokens}`} />
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.75fr)]">
          <div className="cost-panel cost-panel--trend p-5"><div className="mb-4"><h2 className="text-sm font-semibold text-zinc-900">{copy.costTrend}</h2><p className="mt-1 text-xs text-zinc-500">{copy.costTrendDescription}</p></div><TrendChart records={visibleRecords} granularity={granularity} /></div>
          <div className="cost-panel cost-panel--allocation p-5"><h2 className="text-sm font-semibold text-zinc-900">{copy.supplierAllocation}</h2><div className="mt-5 space-y-4">{providers.length === 0 ? <p className="text-sm text-zinc-400">{copy.noUsage}</p> : providers.map(([id, name]) => { const rows = visibleRecords.filter((record) => record.providerId === id); const value = rows.reduce((sum, record) => sum + (record.estimatedCostCny || 0), 0); const share = totals.cost > 0 ? value / totals.cost : 0; return <div key={id}><div className="flex items-center justify-between gap-3 text-sm"><span className="truncate text-zinc-700">{name}</span><span className="shrink-0 font-medium text-zinc-900">{cny(value)}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-indigo-500 to-violet-500" style={{ width: `${Math.max(share * 100, value > 0 ? 2 : 0)}%` }} /></div><p className="mt-1 text-xs text-zinc-400">{tokens(rows.reduce((sum, record) => sum + record.promptTokens + record.completionTokens, 0))} tokens</p></div> })}</div></div>
        </section>

        <section className="cost-panel cost-table"><div className="flex items-center justify-between gap-4 border-b border-zinc-100 px-5 py-4"><div><h2 className="text-sm font-semibold text-zinc-900">Model usage</h2><p className="mt-1 text-xs text-zinc-500">Grouped by supplier and model for the selected time period.</p></div></div><div className="overflow-x-auto"><table className="w-full min-w-[740px] text-sm"><thead className="bg-zinc-50 text-left text-xs font-medium text-zinc-500"><tr><th className="px-5 py-3">Supplier</th><th className="px-5 py-3">Model</th><th className="px-5 py-3 text-right">Cost</th><th className="px-5 py-3 text-right">Calls</th><th className="px-5 py-3 text-right">Input</th><th className="px-5 py-3 text-right">Output</th><th className="px-5 py-3 text-right">Cache hit</th></tr></thead><tbody className="divide-y divide-zinc-100">{breakdown.length === 0 ? <tr><td colSpan={7} className="px-5 py-10 text-center text-zinc-400">No usage records match these filters.</td></tr> : breakdown.map((row) => <tr key={`${row.providerName}:${row.model}`}><td className="px-5 py-3 text-zinc-600">{row.providerName}</td><td className="px-5 py-3 font-mono text-xs text-zinc-800">{row.model}</td><td className="px-5 py-3 text-right font-medium text-zinc-900">{row.priced ? cny(row.cost) : '--'}</td><td className="px-5 py-3 text-right text-zinc-600">{row.calls}</td><td className="px-5 py-3 text-right text-zinc-600">{tokens(row.prompt)}</td><td className="px-5 py-3 text-right text-zinc-600">{tokens(row.completion)}</td><td className="px-5 py-3 text-right text-zinc-600">{row.prompt > 0 ? `${((row.cached / row.prompt) * 100).toFixed(1)}%` : '--'}</td></tr>)}</tbody></table></div></section>

        <section className="cost-panel cost-table"><div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-100 px-5 py-4"><div><h2 className="text-sm font-semibold text-zinc-900">Model rate cards</h2><p className="mt-1 text-xs text-zinc-500">Local reference prices in CNY per million tokens. These determine estimates for records without a provider-reported cost.</p></div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={addRate}><Plus className="mr-1.5 h-3.5 w-3.5" />Add rate</Button><Button size="sm" onClick={() => void saveRates()} disabled={savingRates}><Save className="mr-1.5 h-3.5 w-3.5" />{savingRates ? 'Saving...' : 'Save rates'}</Button></div></div><div className="overflow-x-auto"><table className="w-full min-w-[870px] text-sm"><thead className="bg-zinc-50 text-left text-xs font-medium text-zinc-500"><tr><th className="px-5 py-3">Supplier</th><th className="px-5 py-3">Model</th><th className="px-5 py-3">Input / M</th><th className="px-5 py-3">Cached input / M</th><th className="px-5 py-3">Output / M</th><th className="w-14 px-5 py-3"><span className="sr-only">Remove</span></th></tr></thead><tbody className="divide-y divide-zinc-100">{rateCards.length === 0 ? <tr><td colSpan={6} className="px-5 py-8 text-center text-zinc-400">Add a rate card to estimate models that do not report cost.</td></tr> : rateCards.map((rate) => <tr key={rate.id}><td className="px-5 py-2"><Select value={rate.providerId} onChange={(event) => updateRate(rate.id, { providerId: event.target.value })} options={providers.length ? providers.map(([id, name]) => ({ value: id, label: name })) : [{ value: rate.providerId, label: rate.providerId || 'Supplier ID' }]} /></td><td className="px-5 py-2"><Input value={rate.model} onChange={(event) => updateRate(rate.id, { model: event.target.value })} placeholder="Model ID or *" /></td><td className="px-5 py-2"><Input type="number" min="0" step="0.01" value={rate.inputCnyPerMillion} onChange={(event) => updateRate(rate.id, { inputCnyPerMillion: Number(event.target.value) || 0 })} /></td><td className="px-5 py-2"><Input type="number" min="0" step="0.01" value={rate.cachedInputCnyPerMillion ?? ''} onChange={(event) => updateRate(rate.id, { cachedInputCnyPerMillion: event.target.value === '' ? undefined : Number(event.target.value) || 0 })} /></td><td className="px-5 py-2"><Input type="number" min="0" step="0.01" value={rate.outputCnyPerMillion} onChange={(event) => updateRate(rate.id, { outputCnyPerMillion: Number(event.target.value) || 0 })} /></td><td className="px-5 py-2"><Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-400 hover:text-red-600" onClick={() => removeRate(rate.id)} title="Remove rate"><Trash2 className="h-3.5 w-3.5" /></Button></td></tr>)}</tbody></table></div></section>
      </main>
    </div>
  )
}

function Metric({ icon: Icon, label, value, detail }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; detail: string }) {
  return <div className="cost-metric p-4"><div className="flex items-center gap-2 text-xs font-medium text-zinc-500"><Icon className="h-3.5 w-3.5 text-violet-500" />{label}</div><p className="mt-3 text-2xl font-semibold text-zinc-900">{value}</p><p className="mt-1 truncate text-xs text-zinc-400">{detail}</p></div>
}
