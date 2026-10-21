import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/stores/use-app-store'

const initial = useAppStore.getState()
describe('workspace UI preferences', () => {
  const setConfig = vi.fn().mockResolvedValue(undefined)
  beforeEach(() => {
    useAppStore.setState(initial, true)
    setConfig.mockClear()
    vi.stubGlobal('window', {
      innerWidth: 900,
      eva: {
        config: {
          set: setConfig,
          getAll: vi
            .fn()
            .mockResolvedValue({
              sidebarWidth: 304,
              terminalWidth: 560,
              rightPanelWidth: 360,
              terminalVisible: true,
              rightPanelVisible: true,
            }),
        },
      },
    })
  })
  afterEach(() => {
    useAppStore.setState(initial, true)
    vi.unstubAllGlobals()
  })

  it('starts compact windows with readable content while preserving preferred widths', async () => {
    await useAppStore.getState().loadConfig()
    expect(useAppStore.getState()).toMatchObject({
      terminalVisible: false,
      rightPanelVisible: false,
      terminalWidth: 560,
      rightPanelWidth: 360,
      sidebarWidth: 304,
    })
    expect(setConfig).not.toHaveBeenCalled()
  })
  it('restores visible panels on wide windows', async () => {
    window.innerWidth = 1920
    await useAppStore.getState().loadConfig()
    expect(useAppStore.getState()).toMatchObject({ terminalVisible: true, rightPanelVisible: true })
  })
  it('switches directly from a terminal to the task workspace', () => {
    useAppStore.setState({ terminalVisible: true, rightPanelVisible: true })
    useAppStore.getState().toggleRightPanel()
    expect(useAppStore.getState()).toMatchObject({ terminalVisible: false, rightPanelVisible: true })
    expect(setConfig).toHaveBeenCalledWith('terminalVisible', false)
  })
  it('opens project purposes without persisting a layout or overwriting saved dimensions', () => {
    useAppStore.setState({ rightPanelWidth: 520, taskNoteHeight: 680, terminalVisible: true, settingsOpen: true })
    useAppStore.getState().openPurposeWorkspace()
    expect(useAppStore.getState()).toMatchObject({ currentView: 'chat', settingsOpen: false, terminalVisible: false, rightPanelVisible: true, rightPanelTab: 'purposes', workspaceExpanded: true, rightPanelWidth: 520, taskNoteHeight: 680 })
    useAppStore.getState().setWorkspaceExpanded(false)
    expect(useAppStore.getState()).toMatchObject({ workspaceExpanded: false, rightPanelWidth: 520, taskNoteHeight: 680 })
    expect(setConfig).not.toHaveBeenCalled()
  })
  it('leaves the expanded workspace when closing it or opening a terminal', () => {
    useAppStore.getState().openPurposeWorkspace()
    useAppStore.getState().setRightPanelVisible(false)
    expect(useAppStore.getState().workspaceExpanded).toBe(false)
    useAppStore.getState().openPurposeWorkspace()
    useAppStore.getState().toggleTerminal()
    expect(useAppStore.getState()).toMatchObject({ workspaceExpanded: false, terminalVisible: true })
  })
  it('leaves the expanded workspace when navigating to a different page', () => {
    useAppStore.getState().openPurposeWorkspace()
    useAppStore.getState().setCurrentView('symposium')
    expect(useAppStore.getState()).toMatchObject({ currentView: 'symposium', workspaceExpanded: false })
    useAppStore.getState().openPurposeWorkspace()
    useAppStore.getState().openTaskArtifacts('other-project')
    expect(useAppStore.getState()).toMatchObject({ currentView: 'artifacts', workspaceExpanded: false })
  })
  it('allows compact panels to be explicitly reopened and closed', async () => {
    await useAppStore.getState().loadConfig()
    useAppStore.getState().toggleRightPanel()
    expect(useAppStore.getState().rightPanelVisible).toBe(true)
    useAppStore.getState().toggleRightPanel()
    expect(useAppStore.getState().rightPanelVisible).toBe(false)
    useAppStore.getState().toggleTerminal()
    expect(useAppStore.getState().terminalVisible).toBe(true)
  })
})
