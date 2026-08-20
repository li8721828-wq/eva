import { create } from 'zustand'
import type { WorkMode } from '../../shared/types'
import type { FileAccessGrant } from '../../shared/types/file-access'

export type AppView = 'chat' | 'editor' | 'settings' | 'artifacts' | 'symposium' | 'cost'
export type Theme = 'dark' | 'light'
export type AppLanguage = 'en' | 'zh' | 'ja'

interface CurrentFile {
  path: string
  content: string
  language: string
}

interface AppState {
  theme: Theme
  language: AppLanguage
  sidebarCollapsed: boolean
  sidebarWidth: number
  rightPanelWidth: number
  taskNoteHeight: number | null
  explorerHeight: number
  workMode: WorkMode
  workspacePath: string
  fileAccessGrants: FileAccessGrant[]
  currentView: AppView
  artifactWorkspaceId: string | null
  rightPanelVisible: boolean
  rightPanelTab: 'tasks' | 'files' | 'requirements' | 'editor'
  terminalVisible: boolean
  terminalHeight: number
  terminalWidth: number
  settingsOpen: boolean
  agentManagerOpen: boolean
  specSelectorOpen: boolean
  currentFile: CurrentFile | null
  activeProviderId: string
  activeModel: string

  setTheme: (theme: Theme) => void
  setLanguage: (language: AppLanguage) => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setRightPanelWidth: (width: number) => void
  setTaskNoteHeight: (height: number | null) => void
  setExplorerHeight: (height: number) => void
  setWorkMode: (mode: WorkMode) => void
  setWorkspacePath: (path: string) => void
  setFileAccessGrants: (grants: FileAccessGrant[]) => void
  setCurrentView: (view: AppView) => void
  openTaskArtifacts: (workspaceId: string) => void
  closeTaskArtifacts: () => void
  toggleRightPanel: () => void
  setRightPanelVisible: (visible: boolean) => void
  setRightPanelTab: (tab: 'tasks' | 'files' | 'requirements' | 'editor') => void
  toggleTerminal: () => void
  setTerminalVisible: (visible: boolean) => void
  setTerminalHeight: (height: number) => void
  setTerminalWidth: (width: number) => void
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
  language: 'en',
  sidebarCollapsed: false,
  sidebarWidth: 304,
  rightPanelWidth: 360,
  taskNoteHeight: null,
  explorerHeight: 380,
  workMode: 'normal',
  workspacePath: '',
  fileAccessGrants: [],
  currentView: 'chat',
  artifactWorkspaceId: null,
  rightPanelVisible: true,
  rightPanelTab: 'tasks',
  terminalVisible: false,
  terminalHeight: 560,
  terminalWidth: 560,
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
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  setRightPanelWidth: (rightPanelWidth) => set({ rightPanelWidth }),
  setTaskNoteHeight: (taskNoteHeight) => set({ taskNoteHeight }),
  setExplorerHeight: (explorerHeight) => set({ explorerHeight }),
  setWorkMode: (mode) => set({ workMode: mode }),
  setWorkspacePath: (path) => {
    set({ workspacePath: path })
    window.eva.config.set('workspacePath', path).catch(console.error)
  },
  setLanguage: (language) => {
    set({ language })
    window.eva.config.set('language', language).catch(console.error)
  },
  setFileAccessGrants: (fileAccessGrants) => {
    set({ fileAccessGrants })
    window.eva.config.set('fileAccessGrants', fileAccessGrants).catch(console.error)
  },
  setCurrentView: (view) => set({ currentView: view }),
  openTaskArtifacts: (workspaceId) => set({ currentView: 'artifacts', artifactWorkspaceId: workspaceId }),
  closeTaskArtifacts: () => set({ currentView: 'chat', artifactWorkspaceId: null }),
  toggleRightPanel: () => set((s) => {
    const visible = !s.rightPanelVisible
    window.eva.config.set('rightPanelVisible', visible).catch(console.error)
    return { rightPanelVisible: visible }
  }),
  setRightPanelVisible: (visible) => set({ rightPanelVisible: visible }),
  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
  setTerminalVisible: (visible) => {
    window.eva.config.set('terminalVisible', visible).catch(console.error)
    set({ terminalVisible: visible })
  },
  toggleTerminal: () => get().setTerminalVisible(!get().terminalVisible),
  setTerminalHeight: (terminalHeight) => set({ terminalHeight }),
  setTerminalWidth: (terminalWidth) => set({ terminalWidth }),
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
        language: ['en', 'zh', 'ja'].includes(config.language as string) ? config.language as AppLanguage : 'en',
        sidebarCollapsed: (config.sidebarCollapsed as boolean) ?? false,
        sidebarWidth: Math.max(240, Math.min(440, Number(config.sidebarWidth) || 304)),
        rightPanelWidth: Math.max(300, Math.min(640, Number(config.rightPanelWidth) || 360)),
        taskNoteHeight: Number.isFinite(Number(config.taskNoteHeight)) && Number(config.taskNoteHeight) > 0
          ? Math.max(340, Number(config.taskNoteHeight))
          : null,
        explorerHeight: Math.max(180, Number(config.explorerHeight) || 380),
        workspacePath: (config.workspacePath as string) || '',
        fileAccessGrants: (config.fileAccessGrants as FileAccessGrant[]) || [],
        rightPanelVisible: (config.rightPanelVisible as boolean) ?? true,
        terminalVisible: (config.terminalVisible as boolean) ?? false,
        terminalHeight: Math.max(220, Math.min(960, Number(config.terminalHeight) || 560)),
        terminalWidth: Math.max(380, Math.min(960, Number(config.terminalWidth) || 560)),
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
