import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentConfig } from '../../../shared/types'
import type { ProviderConfigEntry } from '../../../shared/types/provider'
import { TOOL_CATALOG } from '../../../shared/tool-catalog'
import { useAgentStore } from '@/stores/use-agent-store'
import { useAppStore } from '@/stores/use-app-store'
import { uiCopy } from '@/lib/ui-copy'
import { AgentEditor } from './AgentEditor'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogClose } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { ModelAccessPanel } from './ModelAccessPanel'
import { ToolAccessPanel } from './ToolAccessPanel'
import { AlertTriangle, Bot, Braces, ChevronLeft, Cpu, Pencil, Plus, Search, Trash2, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'

type WorkspaceView = 'details' | 'create' | 'edit' | 'tools' | 'models' | 'confirm-delete'

export interface AgentManagementWorkspaceProps {
  className?: string
}

function agentToolsLabel(toolId: string) {
  return TOOL_CATALOG.find((tool) => tool.id === toolId)?.label ?? toolId.replace(/_/g, ' ')
}

function agentDisplayName(agent: AgentConfig, copy: typeof uiCopy.en.agents) {
  if (!agent.isBuiltIn) return agent.name
  const names: Record<string, string> = {
    'Coding Assistant': copy.codingAssistant,
    'Code Reviewer': copy.codeReviewer,
    'Research Analyst': copy.researchAnalyst,
    'Team Leader': copy.teamLeader,
  }
  return names[agent.name] ?? agent.name
}

function roleLabel(role: AgentConfig['role'], copy: typeof uiCopy.en.agents) {
  const labels: Record<AgentConfig['role'], string> = {
    coder: copy.coder,
    reviewer: copy.reviewer,
    researcher: copy.researcher,
    leader: copy.leader,
    tester: copy.tester,
    custom: copy.customRole,
  }
  return labels[role]
}

function AgentCard({ agent, onOpen, copy }: { agent: AgentConfig; onOpen: () => void; copy: typeof uiCopy.en.agents }) {
  const candidates = agent.modelCandidates?.length ? agent.modelCandidates : [{ providerId: agent.providerId, model: agent.model }]
  const previewTools = agent.tools.slice(0, 3)

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-h-[218px] w-full flex-col rounded-lg border border-indigo-100/90 bg-white/85 p-5 text-left shadow-[0_12px_28px_-26px_rgba(30,41,59,0.55)] transition-all duration-200 hover:-translate-y-0.5 hover:border-violet-200 hover:bg-white hover:shadow-[0_18px_32px_-24px_rgba(79,70,229,0.38)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200"
    >
      <div className="flex items-start justify-between gap-3">
        <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg', agent.isBuiltIn ? 'bg-violet-50 text-violet-600' : 'bg-cyan-50 text-cyan-700')}>
          {agent.isBuiltIn ? <Bot className="h-4.5 w-4.5" /> : <Braces className="h-4.5 w-4.5" />}
        </span>
        <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium', agent.isBuiltIn ? 'bg-zinc-100 text-zinc-500' : 'bg-cyan-50 text-cyan-700')}>
          {agent.isBuiltIn ? copy.builtInBadge : copy.customBadge}
        </span>
      </div>

      <div className="mt-4 min-w-0">
        <h3 className="truncate text-base font-semibold text-zinc-900 group-hover:text-violet-800">{agentDisplayName(agent, copy)}</h3>
        <p className="mt-1 text-xs font-medium uppercase tracking-[0.1em] text-violet-600">{roleLabel(agent.role, copy)}</p>
        <p className="mt-2 line-clamp-2 min-h-[40px] text-sm leading-5 text-zinc-500">{agent.description || copy.noDescription}</p>
      </div>

      <div className="mt-auto border-t border-zinc-100 pt-3">
        <div className="flex items-center gap-4 text-xs text-zinc-500">
          <span className="inline-flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5 text-cyan-600" />{candidates.length} {copy.models}</span>
          <span className="inline-flex items-center gap-1.5"><Wrench className="h-3.5 w-3.5 text-violet-600" />{agent.tools.length} {copy.tools}</span>
        </div>
        {previewTools.length > 0 && (
          <p className="mt-2 truncate text-xs text-zinc-400">{previewTools.map(agentToolsLabel).join(' · ')}{agent.tools.length > previewTools.length ? ` +${agent.tools.length - previewTools.length}` : ''}</p>
        )}
      </div>
    </button>
  )
}

/** A compact agent overview with focused, in-place configuration dialogs. */
export function AgentManagementWorkspace({ className }: AgentManagementWorkspaceProps) {
  const { agents, createAgent, updateAgent, deleteAgent } = useAgentStore()
  const { activeProviderId, activeModel, language } = useAppStore()
  const copy = uiCopy[language].agents
  const [view, setView] = useState<WorkspaceView>('details')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null)
  const [agentToDelete, setAgentToDelete] = useState<AgentConfig | null>(null)
  const [toolSelection, setToolSelection] = useState<string[]>([])
  const [modelSelection, setModelSelection] = useState<NonNullable<AgentConfig['modelCandidates']>>([])
  const [savedProviders, setSavedProviders] = useState<ProviderConfigEntry[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    void window.eva.provider.list().then(setSavedProviders).catch((error) => console.error('Failed to load model connections:', error))
  }, [])

  const filteredAgents = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return agents
    return agents.filter((agent) => [agent.name, agent.description, agent.role].some((value) => value.toLowerCase().includes(normalized)))
  }, [agents, query])

  const builtInAgents = filteredAgents.filter((agent) => agent.isBuiltIn)
  const customAgents = filteredAgents.filter((agent) => !agent.isBuiltIn)

  const openDetails = useCallback((agent: AgentConfig) => {
    setEditingAgent(agent)
    setAgentToDelete(null)
    setView('details')
    setDialogOpen(true)
  }, [])

  const closeDialog = useCallback(() => {
    setDialogOpen(false)
    setView('details')
    setAgentToDelete(null)
  }, [])

  const openCreate = useCallback(() => {
    setEditingAgent(null)
    setAgentToDelete(null)
    setView('create')
    setDialogOpen(true)
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
      setEditingAgent(created)
      setView('details')
    } catch (error) {
      console.error('Failed to create agent:', error)
    }
  }, [createAgent])

  const handleSaveEdit = useCallback(async (data: Partial<AgentConfig>) => {
    if (!editingAgent) return
    try {
      await updateAgent(editingAgent.id, data)
      setEditingAgent({ ...editingAgent, ...data } as AgentConfig)
      setView('details')
    } catch (error) {
      console.error('Failed to update agent:', error)
    }
  }, [editingAgent, updateAgent])

  const handleSaveTools = useCallback(async () => {
    if (!editingAgent) return
    try {
      await updateAgent(editingAgent.id, { tools: toolSelection })
      setEditingAgent({ ...editingAgent, tools: toolSelection })
      setView('details')
    } catch (error) {
      console.error('Failed to update tool access:', error)
    }
  }, [editingAgent, toolSelection, updateAgent])

  const handleSaveModels = useCallback(async () => {
    if (!editingAgent) return
    try {
      await updateAgent(editingAgent.id, { modelCandidates: modelSelection })
      setEditingAgent({ ...editingAgent, modelCandidates: modelSelection })
      setView('details')
    } catch (error) {
      console.error('Failed to update model access:', error)
    }
  }, [editingAgent, modelSelection, updateAgent])

  const handleConfirmDelete = useCallback(async () => {
    if (!agentToDelete) return
    try {
      await deleteAgent(agentToDelete.id)
      closeDialog()
    } catch (error) {
      console.error('Failed to delete agent:', error)
    }
  }, [agentToDelete, closeDialog, deleteAgent])

  const detailAgent = editingAgent
  const candidates = detailAgent?.modelCandidates?.length
    ? detailAgent.modelCandidates
    : detailAgent ? [{ providerId: detailAgent.providerId, model: detailAgent.model }] : []

  const renderDetail = () => {
    if (!detailAgent) return null
    return (
      <div>
        <div className="border-b border-zinc-100 px-6 py-6 sm:px-8">
          <div className="flex items-start justify-between gap-5 pr-8">
            <div className="flex min-w-0 gap-3">
              <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', detailAgent.isBuiltIn ? 'bg-violet-50 text-violet-600' : 'bg-cyan-50 text-cyan-700')}>
                {detailAgent.isBuiltIn ? <Bot className="h-5 w-5" /> : <Braces className="h-5 w-5" />}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="dialog-title" className="text-lg font-semibold text-zinc-900">{agentDisplayName(detailAgent, copy)}</h2>
                  <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">{roleLabel(detailAgent.role, copy)}</span>
                </div>
                <p className="mt-1 text-sm leading-6 text-zinc-500">{detailAgent.description || copy.noDescription}</p>
              </div>
            </div>
            {!detailAgent.isBuiltIn && (
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon" onClick={() => setView('edit')} title={copy.edit} aria-label={copy.edit}><Pencil className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" className="text-zinc-400 hover:bg-red-50 hover:text-red-600" onClick={() => { setAgentToDelete(detailAgent); setView('confirm-delete') }} title={copy.delete} aria-label={copy.delete}><Trash2 className="h-4 w-4" /></Button>
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-3 border-b border-zinc-100 px-6 py-5 sm:grid-cols-3 sm:px-8">
          <div className="rounded-lg bg-zinc-50 px-4 py-3"><p className="text-xs text-zinc-500">{copy.temperature}</p><p className="mt-1 text-sm font-semibold text-zinc-800">{detailAgent.temperature}</p></div>
          <div className="rounded-lg bg-zinc-50 px-4 py-3"><p className="text-xs text-zinc-500">{copy.iterationLimit}</p><p className="mt-1 text-sm font-semibold text-zinc-800">{detailAgent.maxIterations}</p></div>
          <div className="rounded-lg bg-zinc-50 px-4 py-3"><p className="text-xs text-zinc-500">{copy.assignedTools}</p><p className="mt-1 text-sm font-semibold text-zinc-800">{detailAgent.tools.length}</p></div>
        </div>

        <div className="space-y-6 px-6 py-6 sm:px-8">
          <section>
            <div className="flex items-start justify-between gap-4">
              <div><h3 className="text-sm font-semibold text-zinc-900">{copy.modelAccess}</h3><p className="mt-1 text-sm text-zinc-500">{copy.modelDescription}</p></div>
              <Button variant="outline" size="sm" onClick={() => handleManageModels(detailAgent)}>{copy.configure}</Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {candidates.length ? candidates.map((candidate) => <span key={`${candidate.providerId}:${candidate.model}`} className="rounded-full bg-cyan-50 px-3 py-1.5 text-xs text-cyan-800">{candidate.providerId} / {candidate.model}</span>) : <span className="text-sm text-zinc-500">{copy.noCandidates}</span>}
            </div>
          </section>

          <section className="border-t border-zinc-100 pt-6">
            <div className="flex items-start justify-between gap-4">
              <div><h3 className="text-sm font-semibold text-zinc-900">{copy.toolAccess}</h3><p className="mt-1 text-sm text-zinc-500">{copy.toolDescription}</p></div>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => handleManageTools(detailAgent)}><Wrench className="h-3.5 w-3.5" />{copy.configure}</Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {detailAgent.tools.length ? detailAgent.tools.map((tool) => <span key={tool} className="rounded-full bg-violet-50 px-3 py-1.5 text-xs text-violet-700">{agentToolsLabel(tool)}</span>) : <span className="text-sm text-zinc-500">{copy.noTools}</span>}
            </div>
          </section>

          <section className="border-t border-zinc-100 pt-6">
            <h3 className="text-sm font-semibold text-zinc-900">{copy.systemInstructions}</h3>
            <p className="mt-1 text-sm text-zinc-500">{detailAgent.isBuiltIn ? copy.builtInInstructions : copy.customInstructions}</p>
            <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-zinc-50 p-4 whitespace-pre-wrap font-mono text-xs leading-5 text-zinc-600">{detailAgent.systemPrompt}</pre>
          </section>
        </div>
      </div>
    )
  }

  const renderDialogContent = () => {
    if (view === 'create' || view === 'edit') {
      return (
        <div className="px-6 py-6 sm:px-8">
          <AgentEditor
            className="p-0"
            agent={view === 'edit' ? editingAgent ?? undefined : undefined}
            defaultProviderId={activeProviderId}
            defaultModel={activeModel}
            onSave={view === 'edit' ? handleSaveEdit : handleSaveCreate}
            onCancel={() => view === 'edit' ? setView('details') : closeDialog()}
          />
        </div>
      )
    }

    if (view === 'tools' && editingAgent) {
      return (
        <div className="px-6 py-6 sm:px-8">
          <button type="button" onClick={() => setView('details')} className="mb-5 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900"><ChevronLeft className="h-4 w-4" />{copy.back} {agentDisplayName(editingAgent, copy)}</button>
          <ToolAccessPanel tools={toolSelection} onChange={setToolSelection} />
          <div className="mt-7 flex justify-end gap-2"><Button variant="outline" onClick={() => setView('details')}>{copy.cancel}</Button><Button onClick={() => void handleSaveTools()}>{copy.saveTools}</Button></div>
        </div>
      )
    }

    if (view === 'models' && editingAgent) {
      return (
        <div className="px-6 py-6 sm:px-8">
          <button type="button" onClick={() => setView('details')} className="mb-5 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900"><ChevronLeft className="h-4 w-4" />{copy.back} {agentDisplayName(editingAgent, copy)}</button>
          <ModelAccessPanel candidates={modelSelection} providers={savedProviders} onChange={setModelSelection} />
          <div className="mt-7 flex justify-end gap-2"><Button variant="outline" onClick={() => setView('details')}>{copy.cancel}</Button><Button onClick={() => void handleSaveModels()}>{copy.saveModels}</Button></div>
        </div>
      )
    }

    if (view === 'confirm-delete' && agentToDelete) {
      return (
        <div className="px-6 py-12 text-center sm:px-8">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-red-50 text-red-500"><AlertTriangle className="h-5 w-5" /></span>
          <h2 id="dialog-title" className="mt-4 text-lg font-semibold text-zinc-900">{copy.deleteQuestion.replace('{name}', agentToDelete.name)}</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-zinc-500">{copy.deleteDescription}</p>
          <div className="mt-6 flex justify-center gap-2"><Button variant="outline" onClick={() => setView('details')}>{copy.keep}</Button><Button variant="destructive" onClick={() => void handleConfirmDelete()}>{copy.delete}</Button></div>
        </div>
      )
    }

    return renderDetail()
  }

  return (
    <div className={cn('min-h-[580px] bg-white/55', className)}>
      <div className="mx-auto w-full max-w-6xl px-6 py-8 sm:px-10 sm:py-10">
        <header className="flex flex-col gap-5 border-b border-zinc-200/80 pb-7 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-violet-600">{copy.workspace}</p>
            <h2 className="mt-2 text-xl font-semibold text-zinc-900">{copy.heading}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">{copy.description}</p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <div className="relative min-w-0 sm:w-60"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.search} className="pl-9" /></div>
            <Button className="gap-1.5" onClick={openCreate}><Plus className="h-4 w-4" />{copy.create}</Button>
          </div>
        </header>

        <section className="pt-8">
          <div className="mb-4 flex items-center gap-3"><h3 className="text-sm font-semibold text-zinc-800">{copy.builtIn}</h3><span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">{builtInAgents.length}</span></div>
          {builtInAgents.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{builtInAgents.map((agent) => <AgentCard key={agent.id} agent={agent} copy={copy} onOpen={() => openDetails(agent)} />)}</div> : <p className="py-8 text-sm text-zinc-500">{copy.noMatch}</p>}
        </section>

        <section className="mt-9 border-t border-zinc-200/80 pt-8">
          <div className="mb-4 flex items-center justify-between gap-3"><div className="flex items-center gap-3"><h3 className="text-sm font-semibold text-zinc-800">{copy.custom}</h3><span className="rounded-full bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-700">{customAgents.length}</span></div><button type="button" onClick={openCreate} className="text-sm font-medium text-violet-700 hover:text-violet-900">{copy.specialist}</button></div>
          {customAgents.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{customAgents.map((agent) => <AgentCard key={agent.id} agent={agent} copy={copy} onOpen={() => openDetails(agent)} />)}</div> : <button type="button" onClick={openCreate} className="flex min-h-32 w-full items-center justify-center rounded-lg border border-dashed border-indigo-200 bg-white/60 p-6 text-sm font-medium text-violet-700 transition-colors hover:border-violet-300 hover:bg-violet-50/50">{copy.specialist}</button>}
        </section>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => open ? setDialogOpen(true) : closeDialog()} className="max-w-5xl p-0">
        <DialogClose onClose={closeDialog} />
        {renderDialogContent()}
      </Dialog>
    </div>
  )
}
