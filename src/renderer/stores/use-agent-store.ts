import { create } from 'zustand'
import type { AgentConfig } from '../../shared/types'

interface AgentState {
  agents: AgentConfig[]
  primaryChatAgentId: string | null
  selectedAgentId: string | null
  editingAgent: AgentConfig | null

  setAgents: (agents: AgentConfig[]) => void
  setPrimaryChatAgent: (id: string) => Promise<void>
  setSelectedAgentId: (id: string | null) => void
  getSelectedAgent: () => AgentConfig | undefined
  setEditingAgent: (agent: AgentConfig | null) => void

  // Actions
  loadAgents: () => Promise<void>
  selectAgent: (id: string) => void
  createAgent: (config: Partial<AgentConfig>) => Promise<AgentConfig>
  updateAgent: (id: string, updates: Partial<AgentConfig>) => Promise<void>
  deleteAgent: (id: string) => Promise<void>
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  primaryChatAgentId: null,
  selectedAgentId: null,
  editingAgent: null,

  setAgents: (agents) => set({ agents }),
  setPrimaryChatAgent: async (id) => {
    if (!get().agents.some((agent) => agent.id === id)) {
      throw new Error('The selected Agent is no longer available.')
    }
    await window.eva.config.set('primaryChatAgentId', id)
    set({ primaryChatAgentId: id })
  },
  setSelectedAgentId: (id) => set({ selectedAgentId: id }),
  getSelectedAgent: () => get().agents.find((a) => a.id === get().selectedAgentId),
  setEditingAgent: (agent) => set({ editingAgent: agent }),

  loadAgents: async () => {
    try {
      const [list, configuredPrimaryId] = await Promise.all([
        window.eva.agent.list(),
        window.eva.config.get<string | null>('primaryChatAgentId'),
      ])
      const primaryChatAgentId = list.some((agent) => agent.id === configuredPrimaryId)
        ? configuredPrimaryId
        : list[0]?.id || null
      if (primaryChatAgentId !== configuredPrimaryId) {
        await window.eva.config.set('primaryChatAgentId', primaryChatAgentId)
      }
      set({ agents: list, primaryChatAgentId })
      // Select first agent if none selected
      if (!get().selectedAgentId && list.length > 0) {
        set({ selectedAgentId: list[0].id })
      }
    } catch (err) {
      console.error('Failed to load agents:', err)
    }
  },

  selectAgent: (id) => {
    set({ selectedAgentId: id })
  },

  createAgent: async (config) => {
    try {
      const agent = await window.eva.agent.create(config)
      set((s) => ({ agents: [...s.agents, agent] }))
      return agent
    } catch (err) {
      console.error('Failed to create agent:', err)
      throw err
    }
  },

  updateAgent: async (id, updates) => {
    try {
      const updated = await window.eva.agent.update(id, updates)
      set((s) => ({
        agents: s.agents.map((a) => (a.id === id ? updated : a)),
        editingAgent: s.editingAgent?.id === id ? updated : s.editingAgent,
      }))
    } catch (err) {
      console.error('Failed to update agent:', err)
      throw err
    }
  },

  deleteAgent: async (id) => {
    try {
      await window.eva.agent.delete(id)
      set((s) => {
        const agents = s.agents.filter((agent) => agent.id !== id)
        return {
          agents,
          primaryChatAgentId: s.primaryChatAgentId === id ? agents[0]?.id || null : s.primaryChatAgentId,
          selectedAgentId: s.selectedAgentId === id ? null : s.selectedAgentId,
          editingAgent: s.editingAgent?.id === id ? null : s.editingAgent,
        }
      })
    } catch (err) {
      console.error('Failed to delete agent:', err)
      throw err
    }
  },
}))
