import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FolderPlus, Plus, Route, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import type { ProviderConfigEntry } from '../../../shared/types/provider'
import { MODEL_CAPABILITIES, type ModelCapability, type ModelPool, type ModelPoolEntry } from '../../../shared/types/model-pool'

const CAPABILITY_LABELS: Record<ModelCapability, string> = { language: 'Language', reasoning: 'Reasoning', code: 'Code', vision: 'Vision', image: 'Image', video: 'Video', embedding: 'Embedding' }
const modelsFor = (provider?: ProviderConfigEntry) => provider?.models?.length ? provider.models : provider?.defaultModel ? [{ id: provider.defaultModel, name: provider.defaultModel }] : []

export function ModelPoolPanel({ providers }: { providers: ProviderConfigEntry[] }) {
  const [pools, setPools] = useState<ModelPool[]>([])
  const [selectedPoolId, setSelectedPoolId] = useState('')
  const [saved, setSaved] = useState(false)
  const selectableProviders = useMemo(() => providers.filter((provider) => provider.apiKey && modelsFor(provider).length), [providers])
  const selectedPool = pools.find((pool) => pool.id === selectedPoolId)

  useEffect(() => { void window.eva.modelPool.list().then((loaded) => { setPools(loaded); setSelectedPoolId(loaded[0]?.id || '') }).catch(console.error) }, [])
  const updatePool = (id: string, patch: Partial<ModelPool>) => setPools((current) => current.map((pool) => pool.id === id ? { ...pool, ...patch } : pool))
  const addPool = () => {
    const pool: ModelPool = { id: `pool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: `Model pool ${pools.length + 1}`, entries: [] }
    setPools((current) => [...current, pool]); setSelectedPoolId(pool.id)
  }
  const addEntry = () => {
    const provider = selectableProviders[0]; const model = modelsFor(provider)[0]
    if (!selectedPool || !provider || !model) return
    const entry: ModelPoolEntry = { id: `route-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: `${provider.name} · ${model.name}`, providerId: provider.id, model: model.id, capabilities: ['language'], priority: selectedPool.entries.length + 1, enabled: true }
    updatePool(selectedPool.id, { entries: [...selectedPool.entries, entry] })
  }
  const updateEntry = (entryId: string, patch: Partial<ModelPoolEntry>) => selectedPool && updatePool(selectedPool.id, { entries: selectedPool.entries.map((entry) => entry.id === entryId ? { ...entry, ...patch } : entry) })
  const toggleCapability = (entry: ModelPoolEntry, capability: ModelCapability) => updateEntry(entry.id, { capabilities: entry.capabilities.includes(capability) ? entry.capabilities.filter((item) => item !== capability) : [...entry.capabilities, capability] })
  const save = async () => { await window.eva.modelPool.save(pools); setSaved(true); window.setTimeout(() => setSaved(false), 1800) }

  return <section className="mt-6 border-t border-zinc-200 pt-6" aria-label="Model connection pools">
    <div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-sm font-medium text-zinc-800"><Route className="h-4 w-4 text-violet-600" /> Model connection pools</div><p className="mt-1 text-xs leading-5 text-zinc-500">Create separate pools for different agent teams. Each agent selects one pool; requests route only among its capability-matched entries and their backups.</p></div><Button variant="outline" size="sm" className="gap-1.5" onClick={addPool}><FolderPlus className="h-3.5 w-3.5" /> New pool</Button></div>
    {!pools.length ? <p className="mt-4 rounded-md border border-dashed border-[var(--ui-border-strong)] bg-white px-3 py-4 text-xs text-zinc-500">No pools yet. Add a pool, then add model routes to it.</p> : <>
      <div className="mt-4 flex flex-wrap gap-2">{pools.map((pool) => <button key={pool.id} type="button" onClick={() => setSelectedPoolId(pool.id)} className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors ${pool.id === selectedPoolId ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50'}`}>{pool.name}<span className="ml-1.5 text-zinc-400">{pool.entries.length}</span></button>)}</div>
      {selectedPool && <div className="eva-panel mt-4 p-4"><div className="flex items-end gap-2"><div className="min-w-0 flex-1"><label className="mb-1 block text-xs font-medium text-zinc-500">Pool name</label><Input value={selectedPool.name} onChange={(event) => updatePool(selectedPool.id, { name: event.target.value })} /></div><Button variant="outline" size="sm" className="gap-1.5" onClick={addEntry} disabled={!selectableProviders.length}><Plus className="h-3.5 w-3.5" /> Add route</Button><Button variant="ghost" size="icon" className="text-zinc-400 hover:text-red-600" title="Delete pool" aria-label="Delete pool" onClick={() => { const next = pools.filter((pool) => pool.id !== selectedPool.id); setPools(next); setSelectedPoolId(next[0]?.id || '') }}><Trash2 className="h-4 w-4" /></Button></div>
        {!selectableProviders.length && <p className="mt-3 text-xs text-amber-700">Save a connection with an API key and model before adding it to this pool.</p>}
        <div className="mt-4 space-y-3">{selectedPool.entries.length === 0 ? <p className="text-xs text-zinc-500">No routes in this pool. Add a capability route to make it available to agents.</p> : selectedPool.entries.map((entry) => { const provider = selectableProviders.find((item) => item.id === entry.providerId); const models = modelsFor(provider); return <div key={entry.id} className="rounded-md border border-zinc-200 bg-white p-3"><div className="grid gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_80px_auto]"><Input value={entry.name} onChange={(event) => updateEntry(entry.id, { name: event.target.value })} placeholder="Route name" /><Select value={entry.providerId} onChange={(event) => { const next = selectableProviders.find((item) => item.id === event.target.value); updateEntry(entry.id, { providerId: event.target.value, model: modelsFor(next)[0]?.id || '' }) }} options={selectableProviders.map((item) => ({ value: item.id, label: item.name }))} /><Select value={entry.model} onChange={(event) => updateEntry(entry.id, { model: event.target.value })} options={models.map((item) => ({ value: item.id, label: item.name }))} /><Input type="number" min="1" value={entry.priority} onChange={(event) => updateEntry(entry.id, { priority: Number(event.target.value) })} aria-label="Route priority" /><div className="flex items-center gap-1"><input type="checkbox" checked={entry.enabled} onChange={(event) => updateEntry(entry.id, { enabled: event.target.checked })} aria-label="Enable route" /><button type="button" title="Remove route" aria-label="Remove route" onClick={() => updatePool(selectedPool.id, { entries: selectedPool.entries.filter((item) => item.id !== entry.id) })} className="p-1.5 text-zinc-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></div></div><div className="mt-3 flex flex-wrap gap-x-3 gap-y-2">{MODEL_CAPABILITIES.map((capability) => <label key={capability} className="inline-flex items-center gap-1.5 text-xs text-zinc-600"><input type="checkbox" checked={entry.capabilities.includes(capability)} onChange={() => toggleCapability(entry, capability)} />{CAPABILITY_LABELS[capability]}</label>)}</div></div> })}</div>
      </div>}
    </>}
    <div className="mt-4 flex justify-end"><Button size="sm" onClick={() => void save()} className="gap-1.5"><Save className="h-3.5 w-3.5" /> Save pools</Button>{saved && <span className="ml-3 inline-flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> Saved</span>}</div>
  </section>
}
