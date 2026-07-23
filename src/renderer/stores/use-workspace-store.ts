import { create } from 'zustand'
import type { FileAccessGrant } from '../../shared/types/file-access'
import type { Workspace, WorkspacePermissionLevel } from '../../shared/types/workspace'

interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  setActiveWorkspaceId: (id: string | null) => void
  loadWorkspaces: () => Promise<void>
  addWorkspace: () => Promise<Workspace | null>
  updateWorkspace: (id: string, updates: Partial<Workspace>) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
  setPermissionLevel: (id: string, level: WorkspacePermissionLevel) => Promise<void>
  setFileAccessGrants: (id: string, grants: FileAccessGrant[]) => Promise<void>
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

  addWorkspace: async () => {
    const selectedPath = await window.eva.file.selectFolder()
    if (!selectedPath) return null
    const workspace = await window.eva.workspace.create(selectedPath)
    set((state) => ({
      workspaces: [workspace, ...state.workspaces.filter((item) => item.id !== workspace.id)],
      activeWorkspaceId: workspace.id,
    }))
    return workspace
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

  setPermissionLevel: async (id, permissionLevel) => {
    await get().updateWorkspace(id, { permissionLevel })
  },

  setFileAccessGrants: async (id, fileAccessGrants) => {
    await get().updateWorkspace(id, { fileAccessGrants })
  },
}))
