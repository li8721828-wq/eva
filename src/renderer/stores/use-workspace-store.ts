import { create } from 'zustand'
import type { Workspace } from '../../shared/types/workspace'

interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  setActiveWorkspaceId: (id: string | null) => void
  loadWorkspaces: () => Promise<void>
  addWorkspace: () => Promise<Workspace | null>
  addWorkspaceAtPath: (path: string) => Promise<Workspace>
  updateWorkspace: (id: string, updates: Partial<Workspace>) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,

  setActiveWorkspaceId: (activeWorkspaceId) => set({ activeWorkspaceId }),

  loadWorkspaces: async () => {
    const workspaces = await window.eva.workspace.list()
    set((state) => ({
      workspaces,
      activeWorkspaceId:
        state.activeWorkspaceId ||
        workspaces.find((workspace) => workspace.name.toLowerCase() === 'eva')?.id ||
        workspaces[0]?.id ||
        null,
    }))
  },

  addWorkspaceAtPath: async (path) => {
    const workspace = await window.eva.workspace.create(path)
    set((state) => ({
      workspaces: [workspace, ...state.workspaces.filter((item) => item.id !== workspace.id)],
      activeWorkspaceId: workspace.id,
    }))
    return workspace
  },

  addWorkspace: async () => {
    const selectedPath = await window.eva.file.selectFolder()
    if (!selectedPath) return null
    return get().addWorkspaceAtPath(selectedPath)
  },

  updateWorkspace: async (id, updates) => {
    const workspace = await window.eva.workspace.update(id, updates)
    set((state) => ({
      workspaces: state.workspaces.map((item) => (item.id === id ? workspace : item)),
    }))
  },

  deleteWorkspace: async (id) => {
    await window.eva.workspace.delete(id)
    set((state) => {
      const workspaces = state.workspaces.filter((item) => item.id !== id)
      return {
        workspaces,
        activeWorkspaceId: state.activeWorkspaceId === id ? workspaces[0]?.id || null : state.activeWorkspaceId,
      }
    })
  },

}))
