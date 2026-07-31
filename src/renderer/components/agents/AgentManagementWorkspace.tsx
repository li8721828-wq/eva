import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentConfig } from '../../../shared/types'
import type { ProviderConfigEntry } from '../../../shared/types/provider'
import { useAgentStore } from '@/stores/use-agent-store'
import { useAppStore } from '@/stores/use-app-store'
import { AgentSelector } from './AgentSelector'
import { AgentEditor } from './AgentEditor'
import { Button } from '@/components/ui/Button'
import { ModelAccessPanel } from './ModelAccessPanel'
import { ToolAccessPanel } from './ToolAccessPanel'
import { AlertTriangle, Bot, ChevronLeft, Pencil, Trash2, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'

type WorkspaceView = 'details' | 'create' | 'edit' | 'tools' | 'models' | 'confirm-delete'

export interface AgentManagementWorkspaceProps {
  className?: string
}

/**
 * Shared, full-width Agent administration surface. It intentionally has no
 * modal shell, so Settings and the standalone manager expose the same flow.
 */
export function AgentManagementWorkspace({ className }: AgentManagementWorkspaceProps) {
  const { agents, createAgent, updateAgent, deleteAgent, selectedAgentId } = useAgentStore()
  const { activeProviderId, activeModel } = useAppStore()
  const [view, setView] = useState<WorkspaceView>('details')
  const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null)
  const [agentToDelete, setAgentToDelete] = useState<AgentConfig | null>(null)
  const [toolSelection, setToolSelection] = useState<string[]>([])
  const [modelSelection, setModelSelection] = useState<NonNullable<AgentConfig['modelCandidates']>>([])
  const [savedProviders, setSavedProviders] = useState<ProviderConfigEntry[]>([])

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null,
    [agents, selectedAgentId]
  )
  const detailAgent = editingAgent ?? selectedAgent

  useEffect(() => {
    void window.eva.provider.list().then(setSavedProviders).catch((error) => console.error('Failed to load model connections:', error))
  }, [])

  const showDetails = useCallback((agent?: AgentConfig | null) => {
    setEditingAgent(agent ?? null)
    setAgentToDelete(null)
    setView('details')
  }, [])

  const handleSelect = useCallback((agent: AgentConfig) => showDetails(agent), [showDetails])

  const handleNew = useCallback(() => {
    setEditingAgent(null)
    setView('create')
  }, [])

  const handleEdit = useCallback((agent: AgentConfig) => {
    setEditingAgent(agent)
    setView('edit')
  }, [])

  const handleManageTools = useCallback((agent: AgentConfig) => {
    setEditingAgent(agent)
    setToolSelection(agent.tools)
    setView('tools')
  }, [])

  const handleManageModels = useCallback((agent: AgentConfig) => {
    setEditingAgent(agent)
    setModelSelection(agent.modelCandidates?.length ? agent.modelCandidates : [{ providerId: agent.providerId, model: agent.model }])
    setView('models')
  }, [])

  const handleSaveCreate = useCallback(async (data: Partial<AgentConfig>) => {
    try {
      const created = await createAgent(data)
      useAgentStore.getState().setSelectedAgentId(created.id)
      showDetails(created)
    } catch (error) {
      console.error('Failed to create agent:', error)
    }
  }, [createAgent, showDetails])

  const handleSaveEdit = useCallback(async (data: Partial<AgentConfig>) => {
    if (!editingAgent) return
    try {
      await updateAgent(editingAgent.id, data)
      showDetails({ ...editingAgent, ...data } as AgentConfig)
    } catch (error) {
      console.error('Failed to update agent:', error)
    }
  }, [editingAgent, showDetails, updateAgent])

  const handleSaveTools = useCallback(async () => {
    if (!editingAgent) return
    try {
      await updateAgent(editingAgent.id, { tools: toolSelection })
      showDetails({ ...editingAgent, tools: toolSelection })
    } catch (error) {
      console.error('Failed to update tool access:', error)
    }
  }, [editingAgent, showDetails, toolSelection, updateAgent])

  const handleSaveModels = useCallback(async () => {
    if (!editingAgent) return
    try {
      await updateAgent(editingAgent.id, { modelCandidates: modelSelection })
      showDetails({ ...editingAgent, modelCandidates: modelSelection })
    } catch (error) {
      console.error('Failed to update model access:', error)
    }
  }, [editingAgent, modelSelection, showDetails, updateAgent])

  const handleConfirmDelete = useCallback(async () => {
    if (!agentToDelete) return
    try {
      await deleteAgent(agentToDelete.id)
      showDetails(null)
    } catch (error) {
      console.error('Failed to delete agent:', error)
    }
  }, [agentToDelete, deleteAgent, showDetails])

  const backToDetails = () => showDetails(editingAgent)

  const renderDetails = () => {
    if (!detailAgent) {
      return (
        <div className="flex h-full flex-col items-center justify-center px-8 text-center">
          <Bot className="h-8 w-8 text-violet-300" />
          <h3 className="mt-4 text-base font-semibold text-zinc-900">No agents yet</h3>
          <p className="mt-1 max-w-sm text-sm leading-6 text-zinc-500">Create a specialist for a focused responsibility, then choose its models and tools.</p>
          <Button className="mt-5" onClick={handleNew}>Create agent</Button>
        </div>
      )
    }

    const candidates = detailAgent.modelCandidates?.length
      ? detailAgent.modelCandidates
      : [{ providerId: detailAgent.providerId, model: detailAgent.model }]

    return (
      <div className="mx-auto w-full max-w-3xl px-7 py-7 sm:px-10 sm:py-9">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 pb-6">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-violet-600">{detailAgent.isBuiltIn ? 'Built-in agent' : 'Custom agent'}</p>
            <h2 className="mt-2 text-xl font-semibold text-zinc-900">{detailAgent.name}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600">{detailAgent.description || 'No description provided.'}</p>
          </div>
          {!detailAgent.isBuiltIn && (
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => handleEdit(detailAgent)}><Pencil className="h-3.5 w-3.5" />Edit</Button>
              <Button variant="ghost" size="sm" className="gap-1.5 text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => { setAgentToDelete(detailAgent); setView('confirm-delete') }}><Trash2 className="h-3.5 w-3.5" />Delete</Button>
            </div>
          )}
        </div>

        <section className="grid gap-6 py-7 sm:grid-cols-3">
          <div><p className="text-xs font-medium uppercase tracking-[0.1em] text-zinc-400">Role</p><p className="mt-2 text-sm font-medium capitalize text-zinc-800">{detailAgent.role}</p></div>
          <div><p className="text-xs font-medium uppercase tracking-[0.1em] text-zinc-400">Temperature</p><p className="mt-2 text-sm font-medium text-zinc-800">{detailAgent.temperature}</p></div>
          <div><p className="text-xs font-medium uppercase tracking-[0.1em] text-zinc-400">Iteration limit</p><p className="mt-2 text-sm font-medium text-zinc-800">{detailAgent.maxIterations}</p></div>
        </section>

        <section className="border-t border-zinc-200 py-7">
          <div className="flex items-start justify-between gap-5">
            <div><h3 className="text-sm font-semibold text-zinc-900">Model access</h3><p className="mt-1 text-sm leading-6 text-zinc-500">Connections this agent may select when it works independently or as part of a team.</p></div>
            <Button variant="outline" size="sm" onClick={() => handleManageModels(detailAgent)}>Configure</Button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {candidates.map((candidate) => <span key={`${candidate.providerId}:${candidate.model}`} className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-700">{candidate.providerId} / {candidate.model}</span>)}
          </div>
        </section>

        <section className="border-t border-zinc-200 py-7">
          <div className="flex items-start justify-between gap-5">
            <div><h3 className="text-sm font-semibold text-zinc-900">Tool access</h3><p className="mt-1 text-sm leading-6 text-zinc-500">Atomic capabilities assigned to this agent. The agent decides when and how to use them.</p></div>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => handleManageTools(detailAgent)}><Wrench className="h-3.5 w-3.5" />Configure</Button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {detailAgent.tools.length > 0 ? detailAgent.tools.map((tool) => <span key={tool} className="rounded-full bg-violet-50 px-3 py-1 text-xs text-violet-700">{tool}</span>) : <span className="text-sm text-zinc-500">No tools assigned.</span>}
          </div>
        </section>

        <section className="border-t border-zinc-200 py-7">
          <h3 className="text-sm font-semibold text-zinc-900">System instructions</h3>
          <p className="mt-1 text-sm leading-6 text-zinc-500">{detailAgent.isBuiltIn ? 'Built-in instructions are maintained by Eva. Tool and model access remain configurable.' : 'These instructions define the specialist\'s role and working style.'}</p>
          <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap border-l-2 border-violet-200 pl-4 font-mono text-xs leading-6 text-zinc-600">{detailAgent.systemPrompt}</pre>
        </section>
      </div>
    )
  }

  const renderEditor = () => (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-7 py-7 sm:px-10 sm:py-9">
        <button type="button" onClick={backToDetails} className="mb-5 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900"><ChevronLeft className="h-4 w-4" />Back to agent</button>
        <AgentEditor
          className="p-0"
          agent={view === 'edit' ? editingAgent ?? undefined : undefined}
          defaultProviderId={activeProviderId}
          defaultModel={activeModel}
          onSave={view === 'edit' ? handleSaveEdit : handleSaveCreate}
          onCancel={backToDetails}
        />
      </div>
    </div>
  )

  const renderPanel = () => {
    if (view === 'create' || view === 'edit') return renderEditor()
    if (view === 'tools' && editingAgent) {
      return <div className="h-full overflow-y-auto"><div className="mx-auto w-full max-w-3xl px-7 py-7 sm:px-10 sm:py-9"><button type="button" onClick={backToDetails} className="mb-5 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900"><ChevronLeft className="h-4 w-4" />Back to agent</button><ToolAccessPanel tools={toolSelection} onChange={setToolSelection} /><div className="mt-7 flex justify-end gap-2"><Button variant="outline" onClick={backToDetails}>Cancel</Button><Button onClick={() => void handleSaveTools()}>Save tool access</Button></div></div></div>
    }
    if (view === 'models' && editingAgent) {
      return <div className="h-full overflow-y-auto"><div className="mx-auto w-full max-w-3xl px-7 py-7 sm:px-10 sm:py-9"><button type="button" onClick={backToDetails} className="mb-5 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900"><ChevronLeft className="h-4 w-4" />Back to agent</button><ModelAccessPanel candidates={modelSelection} providers={savedProviders} onChange={setModelSelection} /><div className="mt-7 flex justify-end gap-2"><Button variant="outline" onClick={backToDetails}>Cancel</Button><Button onClick={() => void handleSaveModels()}>Save model access</Button></div></div></div>
    }
    if (view === 'confirm-delete' && agentToDelete) {
      return <div className="flex h-full flex-col items-center justify-center px-8 text-center"><AlertTriangle className="h-9 w-9 text-red-400" /><h2 className="mt-4 text-lg font-semibold text-zinc-900">Delete {agentToDelete.name}?</h2><p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500">This permanently removes the custom Agent and its standalone configuration. Existing conversations are not deleted.</p><div className="mt-6 flex gap-2"><Button variant="outline" onClick={backToDetails}>Keep agent</Button><Button variant="destructive" className="gap-1.5" onClick={() => void handleConfirmDelete()}><Trash2 className="h-4 w-4" />Delete agent</Button></div></div>
    }
    return renderDetails()
  }

  return (
    <div className={cn('grid min-h-[580px] overflow-hidden border-y border-zinc-200 bg-white lg:grid-cols-[minmax(250px,310px)_minmax(0,1fr)]', className)}>
      <aside className="min-h-0 border-b border-zinc-200 bg-zinc-50/70 lg:border-b-0 lg:border-r">
        <AgentSelector className="min-h-[300px] lg:h-full" onSelect={handleSelect} onNew={handleNew} onEdit={handleEdit} onDelete={(agent) => { setAgentToDelete(agent); setView('confirm-delete') }} />
      </aside>
      <main className="min-h-[460px] bg-white">{renderPanel()}</main>
    </div>
  )
}
