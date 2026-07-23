import { create } from 'zustand'
import type { WorkMode } from '../../shared/types'
import type { FileAccessGrant } from '../../shared/types/file-access'

export type AppView = 'chat' | 'editor' | 'settings'
export type Theme = 'dark' | 'light'

interface CurrentFile {
  path: string
  content: string
  language: string
}

interface AppState {
  theme: Theme
  sidebarCollapsed: boolean
  sidebarWidth: number
  workMode: WorkMode
  workspacePath: string
  fileAccessGrants: FileAccessGrant[]
  currentView: AppView
  rightPanelVisible: boolean
  rightPanelTab: 'files' | 'editor'
  terminalVisible: boolean
  settingsOpen: boolean
  agentManagerOpen: boolean
  specSelectorOpen: boolean
  currentFile: CurrentFile | null
  activeProviderId: string
  activeModel: string

  setTheme: (theme: Theme) => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setWorkMode: (mode: WorkMode) => void
  setWorkspacePath: (path: string) => void
  setFileAccessGrants: (grants: FileAccessGrant[]) => void
  setCurrentView: (view: AppView) => void
  toggleRightPanel: () => void
  setRightPanelVisible: (visible: boolean) => void
  setRightPanelTab: (tab: 'files' | 'editor') => void
  toggleTerminal: () => void
  setSettingsOpen: (open: boolean) => void
  setAgentManagerOpen: (open: boolean) => void
  setSpecSelectorOpen: (open: boolean) => void
  openSettings: () => void
  closeSettings: () => void
  setCurrentFile: (file: CurrentFile | null) => void
  setActiveProvider: (id: string) => void
  setActiveModel: (model: string) => void

  loadConfig: () => Promise<void>
  saveConfig: (partial: Partial<AppState>) => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  theme: 'light',
  sidebarCollapsed: false,
  sidebarWidth: 260,
  workMode: 'normal',
  workspacePath: '',
  fileAccessGrants: [],
  currentView: 'chat',
  rightPanelVisible: true,
  rightPanelTab: 'files',
  terminalVisible: false,
  settingsOpen: false,
  agentManagerOpen: false,
  specSelectorOpen: false,
  currentFile: null,
  activeProviderId: 'openai',
  activeModel: 'gpt-4o',

  setTheme: (theme) => {
    set({ theme })
    window.eva.config.set('theme', theme).catch(console.error)
  },
  toggleSidebar: () => set((s) => {
    const collapsed = !s.sidebarCollapsed
    window.eva.config.set('sidebarCollapsed', collapsed).catch(console.error)
    return { sidebarCollapsed: collapsed }
  }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  setWorkMode: (mode) => set({ workMode: mode }),
  setWorkspacePath: (path) => {
    set({ workspacePath: path })
    window.eva.config.set('workspacePath', path).catch(console.error)
  },
  setFileAccessGrants: (fileAccessGrants) => {
    set({ fileAccessGrants })
    window.eva.config.set('fileAccessGrants', fileAccessGrants).catch(console.error)
  },
  setCurrentView: (view) => set({ currentView: view }),
  toggleRightPanel: () => set((s) => {
    const visible = !s.rightPanelVisible
    window.eva.config.set('rightPanelVisible', visible).catch(console.error)
    return { rightPanelVisible: visible }
  }),
  setRightPanelVisible: (visible) => set({ rightPanelVisible: visible }),
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
  toggleTerminal: () => set((s) => {
    const visible = !s.terminalVisible
    window.eva.config.set('terminalVisible', visible).catch(console.error)
    return { terminalVisible: visible }
  }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setAgentManagerOpen: (open) => set({ agentManagerOpen: open }),
  setSpecSelectorOpen: (open) => set({ specSelectorOpen: open }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  setCurrentFile: (file) => set({ currentFile: file }),
  setActiveProvider: (id) => set({ activeProviderId: id }),
  setActiveModel: (model) => set({ activeModel: model }),

  loadConfig: async () => {
    try {
      const config = await window.eva.config.getAll() as Record<string, unknown>
      set({
        theme: (config.theme as Theme) || 'light',
        sidebarCollapsed: (config.sidebarCollapsed as boolean) ?? false,
        workspacePath: (config.workspacePath as string) || '',
        fileAccessGrants: (config.fileAccessGrants as FileAccessGrant[]) || [],
        rightPanelVisible: (config.rightPanelVisible as boolean) ?? true,
        terminalVisible: (config.terminalVisible as boolean) ?? false,
        activeProviderId: (config.activeProviderId as string) || 'openai',
        activeModel: (config.activeModel as string) || 'gpt-4o',
      })
    } catch (err) {
      console.error('Failed to load config:', err)
    }
  },

  saveConfig: async (partial) => {
    try {
      for (const [key, value] of Object.entries(partial)) {
        if (value !== undefined) {
          await window.eva.config.set(key, value)
        }
      }
    } catch (err) {
      console.error('Failed to save config:', err)
    }
  },
}))
