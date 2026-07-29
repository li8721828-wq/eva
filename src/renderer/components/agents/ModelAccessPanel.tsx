import React, { useEffect, useMemo, useState } from 'react'
import type { AgentModelCandidate } from '../../../shared/types/agent'
import type { ProviderConfigEntry } from '../../../shared/types/provider'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Plus, Trash2 } from 'lucide-react'

export function ModelAccessPanel({
  candidates,
  providers,
  onChange,
}: {
  candidates: AgentModelCandidate[]
  providers: ProviderConfigEntry[]
  onChange: (candidates: AgentModelCandidate[]) => void
}) {
  const usableProviders = providers.filter((provider) => provider.apiKey && (provider.models?.length || provider.defaultModel))
  const [providerId, setProviderId] = useState(usableProviders[0]?.id || '')
  const selectedProvider = usableProviders.find((provider) => provider.id === providerId)
  const modelOptions = useMemo(() => {
    const models = selectedProvider?.models?.length
      ? selectedProvider.models
      : selectedProvider?.defaultModel ? [{ id: selectedProvider.defaultModel, name: selectedProvider.defaultModel }] : []
    return models.map((model) => ({ value: model.id, label: model.name }))
  }, [selectedProvider])
  const [model, setModel] = useState('')

  useEffect(() => {
    if (!usableProviders.some((provider) => provider.id === providerId)) {
      setProviderId(usableProviders[0]?.id || '')
    }
  }, [providerId, usableProviders])

  useEffect(() => {
    if (!modelOptions.some((option) => option.value === model)) setModel(modelOptions[0]?.value || '')
  }, [model, modelOptions])

  const addCandidate = () => {
    if (!providerId || !model || candidates.some((candidate) => candidate.providerId === providerId && candidate.model === model)) return
    onChange([...candidates, { providerId, model }])
  }

  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-zinc-500">
        These connections are available to this agent during delegated work. Hiding a connection from the chat picker does not remove it here.
      </p>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <label className="text-xs font-medium text-zinc-500">Connection</label>
          <Select value={providerId} onChange={(event) => setProviderId(event.target.value)} options={usableProviders.map((provider) => ({ value: provider.id, label: provider.name }))} />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <label className="text-xs font-medium text-zinc-500">Model</label>
          <Select value={model} onChange={(event) => setModel(event.target.value)} options={modelOptions} />
        </div>
        <Button type="button" variant="outline" className="gap-1.5" onClick={addCandidate} disabled={!providerId || !model}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      {candidates.length ? (
        <div className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
          {candidates.map((candidate) => {
            const provider = providers.find((item) => item.id === candidate.providerId)
            return (
              <div key={`${candidate.providerId}:${candidate.model}`} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 truncate text-zinc-700">{provider?.name || candidate.providerId} <span className="text-zinc-400">/</span> {candidate.model}</span>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-zinc-400 hover:text-red-600" onClick={() => onChange(candidates.filter((item) => item !== candidate))} title="Remove model access" aria-label="Remove model access">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )
          })}
        </div>
      ) : <p className="text-xs text-amber-700">No candidate models configured. The agent will use its legacy default connection.</p>}
    </div>
  )
}
