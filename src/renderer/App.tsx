import React, { useCallback, useEffect, lazy, Suspense, useRef, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import { useStreaming } from '@/hooks/use-streaming'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { ToastViewport } from '@/components/ToastViewport'
import { TaskArtifactCenter } from '@/components/tasks/TaskArtifactCenter'
import { TaskWorkspacePanel } from '@/components/tasks/TaskWorkspacePanel'
import { SymposiumWorkspace } from '@/components/symposium/SymposiumWorkspace'
import { CostCenter } from '@/components/cost/CostCenter'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { AgentManagerDialog } from '@/components/agents/AgentManagerDialog'
import { AppTitlebar } from '@/components/layout/AppTitlebar'
import { Button } from '@/components/ui/Button'
import { PanelRightClose, Loader2, Maximize2, Minimize2 } from 'lucide-react'
import { shellCopy } from '@/lib/shell-copy'
import { useShallow } from 'zustand/react/shallow'
import { MAIN_MIN_WIDTH, workspaceLayout } from '@/lib/workspace-layout'
import { registerFloatingLayer } from '@/lib/floating-layer'

// Lazy-loaded heavy components
const TerminalPanel = lazy(() => import('@/components/terminal/TerminalPanel').then(m => ({ default: m.TerminalPanel })))

type ResizeTarget = 'sidebar' | 'right-panel' | 'task-note' | 'terminal-height' | 'terminal-width'

const SIDEBAR_MIN_WIDTH = 240
const SIDEBAR_MAX_WIDTH = 440
const RIGHT_PANEL_MIN_WIDTH = 300
const RIGHT_PANEL_MAX_WIDTH = 640
const TERMINAL_MIN_WIDTH = 380
const TERMINAL_MAX_WIDTH = 960
const TERMINAL_MIN_HEIGHT = 220
function resizeWithKeyboard(target: ResizeTarget, event: React.KeyboardEvent) {
  const horizontal = target === 'task-note' || target === 'terminal-height'
  const decrease = horizontal ? 'ArrowUp' : 'ArrowLeft'
  const increase = horizontal ? 'ArrowDown' : 'ArrowRight'
  if (![decrease, increase].includes(event.key)) return
  event.preventDefault()
  const state = useAppStore.getState()
  const delta = (event.key === decrease ? -1 : 1) * (event.shiftKey ? 32 : 16) * (!horizontal && target !== 'sidebar' ? -1 : 1)
  const layout = workspaceLayout(window.innerWidth, state.sidebarCollapsed, state.sidebarWidth, state.terminalVisible ? state.terminalWidth : state.rightPanelWidth, state.terminalVisible)
  const available = layout.overlay ? window.innerWidth - layout.sidebarWidth - 24 : window.innerWidth - layout.sidebarWidth - MAIN_MIN_WIDTH - 8
  const update = (key: 'sidebarWidth' | 'rightPanelWidth' | 'terminalWidth' | 'taskNoteHeight' | 'terminalHeight', value: number) => {
    useAppStore.setState({ [key]: value })
    void window.eva.config.set(key, value).catch(console.error)
  }
  if (target === 'sidebar') update('sidebarWidth', Math.max(240, Math.min(440, window.innerWidth - MAIN_MIN_WIDTH - 8 - (!layout.overlay && (state.rightPanelVisible || state.terminalVisible) ? layout.railWidth : 0), state.sidebarWidth + delta)))
  else if (target === 'right-panel') update('rightPanelWidth', Math.max(300, Math.min(640, available, state.rightPanelWidth + delta)))
  else if (target === 'terminal-width') update('terminalWidth', Math.max(380, Math.min(960, available, state.terminalWidth + delta)))
  else if (target === 'terminal-height') update('terminalHeight', Math.max(220, Math.min(Math.max(220, window.innerHeight - 160), state.terminalHeight + delta)))
  else update('taskNoteHeight', Math.max(340, Math.min(Math.max(340, window.innerHeight - 84), (state.taskNoteHeight ?? event.currentTarget.parentElement?.getBoundingClientRect().height ?? Math.round((layout.railWidth - 26) * 1.618)) + delta)))
}
function ResizeHandle({ target, onPointerDown }: { target: ResizeTarget; onPointerDown: (target: ResizeTarget, event: React.PointerEvent<HTMLDivElement>) => void }) {
  const isHorizontal = target === 'task-note' || target === 'terminal-height'
  const value = useAppStore(s => target === 'sidebar' ? s.sidebarWidth : target === 'right-panel' ? s.rightPanelWidth : target === 'terminal-width' ? s.terminalWidth : target === 'terminal-height' ? s.terminalHeight : s.taskNoteHeight ?? Math.round((s.rightPanelWidth - 26) * 1.618))
  return (
    <div
      role="separator"
      tabIndex={0}
      onKeyDown={(event) => resizeWithKeyboard(target, event)}
      aria-orientation={isHorizontal ? 'horizontal' : 'vertical'}
      aria-valuenow={value}
      aria-label={target === 'terminal-height' ? 'Resize terminal height' : target === 'terminal-width' ? 'Resize terminal width' : isHorizontal ? 'Resize task workspace height' : target === 'sidebar' ? 'Resize sidebar' : 'Resize task workspace width'}
      onPointerDown={(event) => onPointerDown(target, event)}
      className={isHorizontal
        ? target === 'terminal-height'
          ? 'group relative z-10 h-2 shrink-0 cursor-row-resize touch-none after:absolute after:-inset-y-2 after:inset-x-0'
          : 'relative z-10 mx-auto h-3 w-12 shrink-0 cursor-row-resize touch-none after:absolute after:-inset-x-3 after:-inset-y-2'
        : target === 'right-panel'
        ? 'relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-violet-200/60 active:bg-violet-400 after:absolute after:-inset-x-2 after:-inset-y-2'
        : 'relative z-10 w-1 shrink-0 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-violet-200/70 active:bg-violet-400 after:absolute after:-inset-x-2 after:-inset-y-2'}
    >
      {target === 'task-note' && <span className="task-workspace-resize-grip" />}
      {target === 'terminal-height' && <span className="pointer-events-none absolute left-1/2 top-1/2 h-0.5 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-200/70 transition-colors group-hover:bg-violet-300 group-active:bg-violet-500" />}
    </div>
  )
}

function LazyFallback({ className }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center text-zinc-500 ${className || ''}`}>
      <Loader2 className="h-4 w-4 animate-spin" />
    </div>
  )
}

const App: React.FC = () => {
  const {
    rightPanelVisible,
    workspaceExpanded,
    setWorkspaceExpanded,
    toggleRightPanel,
    setRightPanelVisible,
    terminalVisible,
    setTerminalVisible,
    terminalHeight,
    terminalWidth,
    workspacePath,
    loadConfig,
    agentManagerOpen,
    setAgentManagerOpen,
    settingsOpen,
    currentView,
    language,
    sidebarCollapsed,
    sidebarWidth,
    rightPanelWidth,
    theme,
    taskNoteHeight,
    setSidebarWidth,
    setRightPanelWidth,
    setTaskNoteHeight,
    setTerminalHeight,
    setTerminalWidth,
  } = useAppStore(useShallow((state) => ({
    rightPanelVisible: state.rightPanelVisible,
    workspaceExpanded: state.workspaceExpanded,
    setWorkspaceExpanded: state.setWorkspaceExpanded,
    toggleRightPanel: state.toggleRightPanel,
    setRightPanelVisible: state.setRightPanelVisible,
    terminalVisible: state.terminalVisible,
    setTerminalVisible: state.setTerminalVisible,
    terminalHeight: state.terminalHeight,
    terminalWidth: state.terminalWidth,
    workspacePath: state.workspacePath,
    loadConfig: state.loadConfig,
    agentManagerOpen: state.agentManagerOpen,
    setAgentManagerOpen: state.setAgentManagerOpen,
    settingsOpen: state.settingsOpen,
    currentView: state.currentView,
    language: state.language,
    sidebarCollapsed: state.sidebarCollapsed,
    sidebarWidth: state.sidebarWidth,
    rightPanelWidth: state.rightPanelWidth,
    theme: state.theme,
    taskNoteHeight: state.taskNoteHeight,
    setSidebarWidth: state.setSidebarWidth,
    setRightPanelWidth: state.setRightPanelWidth,
    setTaskNoteHeight: state.setTaskNoteHeight,
    setTerminalHeight: state.setTerminalHeight,
    setTerminalWidth: state.setTerminalWidth,
  })))

  const { loadConversations, currentConversationId, refreshConversation } = useChatStore(useShallow((state) => ({
    loadConversations: state.loadConversations,
    currentConversationId: state.currentConversationId,
    refreshConversation: state.refreshConversation,
  })))
  const loadAgents = useAgentStore((state) => state.loadAgents)
  const loadWorkspaces = useWorkspaceStore((state) => state.loadWorkspaces)
  const [activeResize, setActiveResize] = useState<ResizeTarget | null>(null)
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight)
  const railRef = useRef<HTMLElement>(null)
  const layout = workspaceLayout(viewportWidth, sidebarCollapsed, sidebarWidth, terminalVisible ? terminalWidth : rightPanelWidth, terminalVisible)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const sidebarWidthRef = useRef(sidebarWidth)
  const rightPanelWidthRef = useRef(rightPanelWidth)
  const terminalWidthRef = useRef(terminalWidth)

  useEffect(() => { sidebarWidthRef.current = sidebarWidth }, [sidebarWidth])
  useEffect(() => { rightPanelWidthRef.current = rightPanelWidth }, [rightPanelWidth])
  useEffect(() => { terminalWidthRef.current = terminalWidth }, [terminalWidth])
  useEffect(() => () => resizeCleanupRef.current?.(), [])

  const startResize = useCallback((target: ResizeTarget, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeCleanupRef.current?.()
    const startX = event.clientX
    const startY = event.clientY
    const startSidebarWidth = sidebarWidthRef.current
    const startRightPanelWidth = rightPanelWidthRef.current
    const defaultTaskNoteHeight = Math.round((rightPanelWidthRef.current - 26) * 1.618)
    const startTaskNoteHeight = taskNoteHeight || railRef.current?.querySelector('.task-workspace-note')?.getBoundingClientRect().height || defaultTaskNoteHeight
    const startTerminalHeight = terminalHeight
    const startTerminalWidth = terminalWidthRef.current
    setActiveResize(target)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = target === 'task-note' || target === 'terminal-height' ? 'row-resize' : 'col-resize'

    const onMove = (moveEvent: PointerEvent) => {
      if (target === 'sidebar') {
        const available = window.innerWidth - (!layout.overlay && (rightPanelVisible || terminalVisible) ? layout.railWidth : 0) - MAIN_MIN_WIDTH - 8
        setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, available, startSidebarWidth + moveEvent.clientX - startX)))
      } else if (target === 'right-panel') {
        const available = layout.overlay ? window.innerWidth - layout.sidebarWidth - 24 : window.innerWidth - layout.sidebarWidth - MAIN_MIN_WIDTH - 8
        setRightPanelWidth(Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, available, startRightPanelWidth - (moveEvent.clientX - startX))))
      } else if (target === 'task-note') {
        const maxHeight = Math.max(340, window.innerHeight - 84)
        setTaskNoteHeight(Math.max(340, Math.min(maxHeight, startTaskNoteHeight + moveEvent.clientY - startY)))
      } else if (target === 'terminal-height') {
        const maxHeight = Math.max(TERMINAL_MIN_HEIGHT, window.innerHeight - 160)
        setTerminalHeight(Math.max(TERMINAL_MIN_HEIGHT, Math.min(maxHeight, startTerminalHeight + moveEvent.clientY - startY)))
      } else {
        const available = layout.overlay ? window.innerWidth - layout.sidebarWidth - 24 : window.innerWidth - layout.sidebarWidth - MAIN_MIN_WIDTH - 8
        setTerminalWidth(Math.max(TERMINAL_MIN_WIDTH, Math.min(TERMINAL_MAX_WIDTH, available, startTerminalWidth - (moveEvent.clientX - startX))))
      }
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      resizeCleanupRef.current = null
      setActiveResize(null)
      const state = useAppStore.getState()
      const [key, value] = target === 'sidebar'
        ? ['sidebarWidth', state.sidebarWidth]
        : target === 'right-panel'
          ? ['rightPanelWidth', state.rightPanelWidth]
          : target === 'task-note'
            ? ['taskNoteHeight', state.taskNoteHeight]
            : target === 'terminal-height'
              ? ['terminalHeight', state.terminalHeight]
              : ['terminalWidth', state.terminalWidth]
      void window.eva.config.set(key, value).catch(console.error)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onUp)
    resizeCleanupRef.current = onUp
  }, [rightPanelVisible, terminalVisible, layout.overlay, layout.railWidth, layout.sidebarWidth, setRightPanelWidth, setSidebarWidth, setTaskNoteHeight, setTerminalHeight, setTerminalWidth, taskNoteHeight, terminalHeight])

  // Initialize streaming listeners
  useStreaming()

  // Warm the dynamic-import cache for Streamdown so the first chat bubble
  // does not pay the full library load latency on the rendering thread.
  useEffect(() => {
    void import('streamdown').catch(() => {
      // Streamdown is optional; a transient load failure will retry on the
      // next lazy import when a bubble actually needs it.
    })
  }, [])

  // Load data on mount
  useEffect(() => {
    loadConfig()
    loadConversations()
    loadAgents()
    loadWorkspaces()
  }, [])

  useEffect(() => window.eva.conversation.onChanged((_event, conversationId) => {
    void loadConversations()
    // Symposium replies are background updates, not navigation. Keep the
    // reader's current position while refreshing their visible conversation.
    if (conversationId === currentConversationId) void refreshConversation(conversationId)
  }), [currentConversationId, loadConversations, refreshConversation])

  useEffect(() => window.eva.terminal.onPanelVisibility((_event, payload) => {
    // Do not interrupt someone working in another conversation. When the
    // owning conversation is visible, opening the Agent-controlled terminal
    // reveals the exact terminal the Agent is using.
    if (payload.conversationId === currentConversationId) setTerminalVisible(payload.visible)
  }), [currentConversationId, setTerminalVisible])

  // Width preferences survive resizing. Compact rails can be explicitly reopened as drawers.
  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth)
      setViewportHeight(window.innerHeight)
      const state = useAppStore.getState()
      if (!state.workspaceExpanded && workspaceLayout(window.innerWidth, state.sidebarCollapsed, state.sidebarWidth, state.terminalVisible ? state.terminalWidth : state.rightPanelWidth, state.terminalVisible).overlay) {
        state.setRightPanelVisible(false)
        if (state.terminalVisible) state.setTerminalVisible(false)
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Settings can contain long, independently scrollable content. Reset any
  // legacy document scroll before showing a full-height workspace view.
  useEffect(() => {
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
  }, [currentView, settingsOpen])

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja' : 'en'
  }, [language])

  useEffect(() => {
    if (theme === 'light') {
      delete document.documentElement.dataset.theme
    } else {
      document.documentElement.dataset.theme = theme
    }
  }, [theme])

  const projectName = useWorkspaceStore(state => state.workspaces.find(item => item.id === state.activeWorkspaceId)?.name)
  const [compactNote, setCompactNote] = useState(false)
  const copy = shellCopy[language]
  const expanded = currentView === 'chat' && rightPanelVisible && workspaceExpanded && !terminalVisible
  const showRightPanel = currentView === 'chat' && (rightPanelVisible || terminalVisible)
  const noteHeight = Math.min(taskNoteHeight ?? (compactNote ? 310 : Math.round((layout.railWidth - 26) * 1.618)), Math.max(240, viewportHeight - 84))
  useEffect(() => {
    if (!showRightPanel || (!layout.overlay && !expanded) || settingsOpen || !railRef.current) return
    const previous = document.activeElement as HTMLElement | null
    const unregister = registerFloatingLayer({ element: railRef.current, depth: 0, modal: !expanded, dismissOnOutside: !expanded, dismiss: () => {
      if (useAppStore.getState().workspaceExpanded) { useAppStore.getState().setWorkspaceExpanded(false); return }
      useAppStore.getState().setRightPanelVisible(false)
      useAppStore.getState().setTerminalVisible(false)
    } })
    railRef.current.querySelector<HTMLElement>('button')?.focus()
    return () => { unregister(); if (previous?.isConnected) previous.focus() }
  }, [showRightPanel, layout.overlay, expanded, settingsOpen])

  return (
    <ErrorBoundary>
    <div className="eva-app-shell flex h-screen w-screen flex-col overflow-hidden text-zinc-900" data-resizing={activeResize || undefined}>
      <AppTitlebar />
      <div className="eva-workspace flex min-h-0 flex-1">
      {/* Left Sidebar */}
      <Sidebar style={!sidebarCollapsed ? { width: layout.sidebarWidth } : undefined} />
      {!sidebarCollapsed && <ResizeHandle target="sidebar" onPointerDown={startResize} />}

      {/* Main Workspace */}
      <div className="flex flex-1 flex-col min-w-0">
        <div className={settingsOpen ? 'hidden' : 'relative flex min-h-0 min-w-0 flex-1'} aria-hidden={settingsOpen || undefined}>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden" style={expanded ? { visibility: 'hidden' } : undefined} aria-hidden={expanded || undefined}>
            {currentView === 'artifacts' ? <TaskArtifactCenter /> : currentView === 'symposium' ? <SymposiumWorkspace /> : currentView === 'cost' ? <CostCenter /> : <ChatPanel className="h-full" />}
          </div>

          {/* The task workspace toggle lives in the chat header; a closed rail leaves no strip behind. */}

          {/* Right utility rail switches between task workspace and terminal. */}
          {showRightPanel && (
            <>
            {layout.overlay && !expanded && <div className="absolute inset-0 z-30 bg-black/20" aria-hidden="true" />}
            {terminalVisible && !layout.overlay && <ResizeHandle target="terminal-width" onPointerDown={startResize} />}
            <aside ref={railRef} role={expanded ? 'region' : layout.overlay ? 'dialog' : undefined} aria-modal={layout.overlay && !expanded || undefined} className={`eva-utility-rail flex min-h-0 shrink-0 flex-col ${expanded ? 'eva-workspace-expanded absolute inset-0 z-40' : layout.overlay ? 'eva-utility-drawer absolute inset-y-0 right-0 z-40' : ''}`} style={expanded ? undefined : { width: layout.railWidth }} aria-label={terminalVisible ? copy.terminal : copy.workspace}>
              {terminalVisible ? (
                <>
                  <Suspense fallback={<LazyFallback className="h-56" />}>
                    <TerminalPanel height={Math.min(terminalHeight, Math.max(TERMINAL_MIN_HEIGHT, viewportHeight - 100))} className="shrink-0" />
                  </Suspense>
                  <ResizeHandle target="terminal-height" onPointerDown={startResize} />
                </>
              ) : <div className="task-workspace-note flex min-h-0 shrink-0 flex-col" style={expanded ? undefined : { height: noteHeight }}>
                {/* Panel header */}
                <div className="task-workspace-note__header flex items-center justify-between px-4 py-3">
                  <span className="text-sm font-semibold text-zinc-600">{expanded && projectName ? `${projectName} · ${copy.workspace}` : copy.workspace}</span>
                  <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setWorkspaceExpanded(!expanded)} title={expanded ? copy.restoreWorkspace : copy.expandWorkspace} aria-label={expanded ? copy.restoreWorkspace : copy.expandWorkspace}>
                    {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleRightPanel} title={copy.hideWorkspace} aria-label={copy.hideWorkspace}>
                    <PanelRightClose className="h-4 w-4" />
                  </Button>
                  </div>
                </div>

                <TaskWorkspacePanel onCompactChange={setCompactNote} />
              {!expanded && <><div
                  role="separator"
                  tabIndex={0}
                  onKeyDown={(event) => resizeWithKeyboard('task-note', event)}
                  aria-orientation="horizontal"
                  aria-valuenow={noteHeight}
                  aria-label="Resize task workspace height"
                  className="task-workspace-note__resize-edge task-workspace-note__resize-edge--bottom"
                  onPointerDown={(event) => startResize('task-note', event)}
                />
                <div
                  role="separator"
                  tabIndex={0}
                  onKeyDown={(event) => resizeWithKeyboard('right-panel', event)}
                  aria-orientation="vertical"
                  aria-valuenow={rightPanelWidth}
                  aria-label="Resize task workspace width"
                  className="task-workspace-note__resize-edge task-workspace-note__resize-edge--left"
                onPointerDown={(event) => startResize('right-panel', event)}
              /></>}
              </div>}
            </aside>
            </>
          )}
        </div>

        {settingsOpen && <SettingsDialog />}
      </div>

      {/* Agent Manager Dialog */}
      <AgentManagerDialog
        open={agentManagerOpen}
        onOpenChange={setAgentManagerOpen}
      />
      </div>
    </div>
      <ToastViewport />
    </ErrorBoundary>
  )
}

export default App
