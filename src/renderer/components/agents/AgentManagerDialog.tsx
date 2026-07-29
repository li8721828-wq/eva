import React, { useState, useCallback, useEffect } from 'react'
import type { AgentConfig } from '../../../shared/types'
import type { ProviderConfigEntry } from '../../../shared/types/provider'
import { useAgentStore } from '@/stores/use-agent-store'
import { useAppStore } from '@/stores/use-app-store'
import { AgentSelector } from './AgentSelector'
import { AgentEditor } from './AgentEditor'
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogClose } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Trash2, AlertTriangle } from 'lucide-react'
import { ToolAccessPanel } from './ToolAccessPanel'
import { ModelAccessPanel } from './ModelAccessPanel'

export interface AgentManagerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type View = 'list' | 'create' | 'edit' | 'view' | 'tools' | 'models' | 'confirm-delete'

export function AgentManagerDialog({ open, onOpenChange }: AgentManagerDialogProps) {
  const { agents, createAgent, updateAgent, deleteAgent, selectedAgentId } = useAgentStore()
  const { activeProviderId, activeModel } = useAppStore()

  const [view, setView] = useState<View>('list')
  const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null)
  const [agentToDelete, setAgentToDelete] = useState<AgentConfig | null>(null)
  const [toolSelection, setToolSelection] = useState<string[]>([])
  const [modelSelection, setModelSelection] = useState<NonNullable<AgentConfig['modelCandidates']>>([])
  const [savedProviders, setSavedProviders] = useState<ProviderConfigEntry[]>([])

  const selectedAgent = agents.find((a) => a.id === selectedAgentId)

  const handleNew = useCallback(() => {
    setEditingAgent(null)
    setView('create')
  }, [])

  const handleEdit = useCallback((agent: AgentConfig) => {
    setEditingAgent(agent)
    setView('edit')
  }, [])

  const handleView = useCallback((agent: AgentConfig) => {
    setEditingAgent(agent)
    setView('view')
  }, [])

  useEffect(() => {
    if (!open) return
    void window.eva.provider.list().then(setSavedProviders).catch((error) => console.error('Failed to load model connections:', error))
  }, [open])

  const handleManageTools = useCallback((agent: AgentConfig) => {
    setEditingAgent(agent)
    setToolSelection(agent.tools)
    setView('tools')
  }, [])

  const handleSaveTools = useCallback(async () => {
    if (!editingAgent) return
    try {
      await updateAgent(editingAgent.id, { tools: toolSelection })
      setEditingAgent({ ...editingAgent, tools: toolSelection })
      setView('view')
    } catch (err) {
      console.error('Failed to update tool access:', err)
    }
  }, [editingAgent, toolSelection, updateAgent])

  const handleManageModels = useCallback((agent: AgentConfig) => {
    setEditingAgent(agent)
    setModelSelection(agent.modelCandidates?.length ? agent.modelCandidates : [{ providerId: agent.providerId, model: agent.model }])
    setView('models')
  }, [])

  const handleSaveModels = useCallback(async () => {
    if (!editingAgent) return
    try {
      await updateAgent(editingAgent.id, { modelCandidates: modelSelection })
      setEditingAgent({ ...editingAgent, modelCandidates: modelSelection })
      setView('view')
    } catch (error) {
      console.error('Failed to update model access:', error)
    }
  }, [editingAgent, modelSelection, updateAgent])

  const handleDeleteRequest = useCallback((agent: AgentConfig) => {
    setAgentToDelete(agent)
    setView('confirm-delete')
  }, [])

  const handleConfirmDelete = useCallback(async () => {
    if (!agentToDelete) return
    try {
      await deleteAgent(agentToDelete.id)
      setAgentToDelete(null)
      setView('list')
    } catch (err) {
      console.error('Failed to delete agent:', err)
    }
  }, [agentToDelete, deleteAgent])

  const handleSaveCreate = useCallback(
    async (data: Partial<AgentConfig>) => {
      try {
        const created = await createAgent(data)
        setView('list')
        useAgentStore.getState().setSelectedAgentId(created.id)
      } catch (err) {
        console.error('Failed to create agent:', err)
      }
    },
    [createAgent]
  )

  const handleSaveEdit = useCallback(
    async (data: Partial<AgentConfig>) => {
      if (!editingAgent) return
      try {
        await updateAgent(editingAgent.id, data)
        setView('list')
      } catch (err) {
        console.error('Failed to update agent:', err)
      }
    },
    [editingAgent, updateAgent]
  )

  const handleCancel = useCallback(() => {
    setView('list')
    setEditingAgent(null)
    setAgentToDelete(null)
  }, [])

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setView('list')
      setEditingAgent(null)
      setAgentToDelete(null)
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} className="max-w-2xl">
      <DialogClose onClose={() => handleOpenChange(false)} />
      <DialogHeader>
        <DialogTitle>Agent Manager</DialogTitle>
        <DialogDescription>
          {view === 'list' && 'Browse, select, and manage your coding agents.'}
          {view === 'create' && 'Create a new custom agent.'}
          {view === 'edit' && 'Edit agent configuration.'}
          {view === 'view' && 'View built-in agent configuration (read-only).'}
          {view === 'tools' && 'Assign the capabilities available to this agent.'}
          {view === 'models' && 'Choose the saved model connections this agent may use.'}
          {view === 'confirm-delete' && 'Confirm deletion.'}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-[420px]">
        {/* List view */}
        {view === 'list' && (
          <div className="h-[420px] -mx-6 -mb-6">
            <AgentSelector
              onSelect={handleView}
              onNew={handleNew}
              onEdit={handleEdit}
              onDelete={handleDeleteRequest}
              className="h-full"
            />
          </div>
        )}

        {/* Create view */}
        {view === 'create' && (
          <div className="-mx-6 -mb-6 max-h-[500px] overflow-y-auto">
            <AgentEditor
              defaultProviderId={activeProviderId}
              defaultModel={activeModel}
              onSave={handleSaveCreate}
              onCancel={handleCancel}
            />
          </div>
        )}

        {/* Edit view */}
        {view === 'edit' && editingAgent && (
          <div className="-mx-6 -mb-6 max-h-[500px] overflow-y-auto">
            <AgentEditor
              agent={editingAgent}
              onSave={handleSaveEdit}
              onCancel={handleCancel}
            />
          </div>
        )}

        {/* View-only (built-in) */}
        {view === 'view' && editingAgent && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-zinc-500 block mb-1">Name</label>
                <p className="text-sm text-zinc-800">{editingAgent.name}</p>
              </div>
              <div>
                <label className="text-xs text-zinc-500 block mb-1">Role</label>
                <p className="text-sm text-zinc-800 capitalize">{editingAgent.role}</p>
              </div>
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">Description</label>
              <p className="text-sm text-zinc-700">{editingAgent.description}</p>
            </div>
            <div>
              <label className="text-xs text-zinc-500 block mb-1">System Prompt</label>
              <pre className="rounded-lg bg-zinc-50 border border-zinc-200 p-3 text-xs text-zinc-700 font-mono whitespace-pre-wrap max-h-[160px] overflow-y-auto">
                {editingAgent.systemPrompt}
              </pre>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-zinc-500 block mb-1">Provider</label>
                <p className="text-sm text-zinc-800">{editingAgent.providerId}</p>
              </div>
              <div>
                <label className="text-xs text-zinc-500 block mb-1">Model</label>
                <p className="text-sm text-zinc-800">{editingAgent.model}</p>
              </div>
              <div>
                <label className="text-xs text-zinc-500 block mb-1">Temperature</label>
                <p className="text-sm text-zinc-800">{editingAgent.temperature}</p>
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-3">
                <label className="text-xs text-zinc-500">Model access</label>
                <Button variant="outline" size="sm" onClick={() => handleManageModels(editingAgent)}>Configure</Button>
              </div>
              <p className="text-xs text-zinc-500">
                {editingAgent.modelCandidates?.length
                  ? `${editingAgent.modelCandidates.length} candidate model${editingAgent.modelCandidates.length === 1 ? '' : 's'} assigned.`
                  : 'Uses its default model connection.'}
              </p>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-3">
                <label className="text-xs text-zinc-500">Tools</label>
                <Button variant="outline" size="sm" onClick={() => handleManageTools(editingAgent)}>Manage access</Button>
              </div>
              <div className="flex flex-wrap gap-1">
                {editingAgent.tools.map((tool) => (
                  <span
                    key={tool}
                    className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                Close
              </Button>
            </div>
          </div>
        )}

        {view === 'tools' && editingAgent && (
          <div className="-mx-6 -mb-6 max-h-[560px] overflow-y-auto p-6">
            <ToolAccessPanel tools={toolSelection} onChange={setToolSelection} />
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={handleCancel}>Cancel</Button>
              <Button onClick={() => void handleSaveTools()}>Save tool access</Button>
            </div>
          </div>
        )}

        {view === 'models' && editingAgent && (
          <div className="-mx-6 -mb-6 max-h-[560px] overflow-y-auto p-6">
            <ModelAccessPanel candidates={modelSelection} providers={savedProviders} onChange={setModelSelection} />
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setView('view')}>Cancel</Button>
              <Button onClick={() => void handleSaveModels()}>Save model access</Button>
            </div>
          </div>
        )}

        {/* Delete confirmation */}
        {view === 'confirm-delete' && agentToDelete && (
          <div className="flex flex-col items-center gap-4 py-4">
            <AlertTriangle className="h-10 w-10 text-red-400" />
            <div className="text-center">
              <p className="text-sm text-zinc-800">
                Are you sure you want to delete{' '}
                <span className="font-semibold text-zinc-900">{agentToDelete.name}</span>?
              </p>
              <p className="text-xs text-zinc-500 mt-1">This action cannot be undone.</p>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleConfirmDelete} className="gap-1.5">
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}
