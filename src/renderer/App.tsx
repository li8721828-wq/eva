import React, { useCallback, useEffect, lazy, Suspense, useRef, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import { useStreaming } from '@/hooks/use-streaming'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { TaskArtifactCenter } from '@/components/tasks/TaskArtifactCenter'
import { TaskWorkspacePanel } from '@/components/tasks/TaskWorkspacePanel'
import { SymposiumWorkspace } from '@/components/symposium/SymposiumWorkspace'
import { CostCenter } from '@/components/cost/CostCenter'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { AgentManagerDialog } from '@/components/agents/AgentManagerDialog'
import { AppTitlebar } from '@/components/layout/AppTitlebar'
import { Button } from '@/components/ui/Button'
import { PanelRightClose, PanelRight, Loader2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'

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
function ResizeHandle({ target, onPointerDown }: { target: ResizeTarget; onPointerDown: (target: ResizeTarget, event: React.PointerEvent<HTMLDivElement>) => void }) {
  const isHorizontal = target === 'task-note' || target === 'terminal-height'
  return (
    <div
      role="separator"
      aria-orientation={isHorizontal ? 'horizontal' : 'vertical'}
      aria-label={target === 'terminal-height' ? 'Resize terminal height' : target === 'terminal-width' ? 'Resize terminal width' : isHorizontal ? 'Resize task workspace height' : target === 'sidebar' ? 'Resize sidebar' : 'Resize task workspace width'}
      onPointerDown={(event) => onPointerDown(target, event)}
      className={isHorizontal
        ? target === 'terminal-height'
          ? 'group relative z-10 h-2 shrink-0 cursor-row-resize touch-none after:absolute after:-inset-y-2 after:inset-x-0'
          : 'relative z-10 mx-auto h-3 w-12 shrink-0 cursor-row-resize touch-none after:absolute after:-inset-x-3 after:-inset-y-2'
        : target === 'right-panel'
        ? 'relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-violet-200/60 active:bg-violet-400 after:absolute after:-inset-x-2 after:-inset-y-2'
        : 'relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-zinc-100 transition-colors hover:bg-violet-300 active:bg-violet-500 after:absolute after:-inset-x-2 after:-inset-y-2'}
    >
      {target === 'task-note' && <span className="task-workspace-resize-grip" />}
      {target === 'terminal-height' && <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-zinc-200 transition-colors group-hover:bg-violet-300 group-active:bg-violet-500" />}
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
    taskNoteHeight,
    setSidebarWidth,
    setRightPanelWidth,
    setTaskNoteHeight,
    setTerminalHeight,
    setTerminalWidth,
  } = useAppStore(useShallow((state) => ({
    rightPanelVisible: state.rightPanelVisible,
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
    const startTaskNoteHeight = taskNoteHeight || defaultTaskNoteHeight
    const startTerminalHeight = terminalHeight
    const startTerminalWidth = terminalWidthRef.current
    setActiveResize(target)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = target === 'task-note' || target === 'terminal-height' ? 'row-resize' : 'col-resize'

    const onMove = (moveEvent: PointerEvent) => {
      if (target === 'sidebar') {
        const available = window.innerWidth - (rightPanelVisible ? rightPanelWidthRef.current : 0) - 480
        setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, available, startSidebarWidth + moveEvent.clientX - startX)))
      } else if (target === 'right-panel') {
        const available = window.innerWidth - sidebarWidthRef.current - 480
        setRightPanelWidth(Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, available, startRightPanelWidth - (moveEvent.clientX - startX))))
      } else if (target === 'task-note') {
        const maxHeight = Math.max(340, window.innerHeight - 84)
        setTaskNoteHeight(Math.max(340, Math.min(maxHeight, startTaskNoteHeight + moveEvent.clientY - startY)))
      } else if (target === 'terminal-height') {
        const maxHeight = Math.max(TERMINAL_MIN_HEIGHT, window.innerHeight - 160)
        setTerminalHeight(Math.max(TERMINAL_MIN_HEIGHT, Math.min(maxHeight, startTerminalHeight + moveEvent.clientY - startY)))
      } else {
        const available = window.innerWidth - sidebarWidthRef.current - 360
        setTerminalWidth(Math.max(TERMINAL_MIN_WIDTH, Math.min(TERMINAL_MAX_WIDTH, available, startTerminalWidth - (moveEvent.clientX - startX))))
      }
    }
    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
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
    resizeCleanupRef.current = onUp
  }, [rightPanelVisible, setRightPanelWidth, setSidebarWidth, setTaskNoteHeight, setTerminalHeight, setTerminalWidth, taskNoteHeight, terminalHeight])

  // Initialize streaming listeners
  useStreaming()

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

  // Responsive: auto-hide right panel on small windows
  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth
      if (width < 1000 && rightPanelVisible) {
        setRightPanelVisible(false)
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [rightPanelVisible, setRightPanelVisible])

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

  const showRightPanel = currentView === 'chat' && (rightPanelVisible || terminalVisible)

  return (
    <ErrorBoundary>
    <div className="eva-app-shell flex h-screen w-screen flex-col overflow-hidden text-zinc-900" data-resizing={activeResize || undefined}>
      <AppTitlebar />
      <div className="eva-workspace flex min-h-0 flex-1">
      {/* Left Sidebar */}
      <Sidebar style={!sidebarCollapsed ? { width: sidebarWidth } : undefined} />
      {!sidebarCollapsed && <ResizeHandle target="sidebar" onPointerDown={startResize} />}

      {/* Main Workspace */}
      <div className="flex flex-1 flex-col min-w-0">
        <div className={settingsOpen ? 'hidden' : 'flex min-h-0 min-w-0 flex-1'} aria-hidden={settingsOpen || undefined}>
          <div className="min-h-0 min-w-0 flex-1">
            {currentView === 'artifacts' ? <TaskArtifactCenter /> : currentView === 'symposium' ? <SymposiumWorkspace /> : currentView === 'cost' ? <CostCenter /> : <ChatPanel className="h-full" />}
          </div>

          {/* Right Panel Toggle */}
          {currentView === 'chat' && !rightPanelVisible && !terminalVisible && (
            <div className="flex flex-col items-center border-l border-indigo-100 bg-white/70 py-2 px-1 backdrop-blur-sm">
              <Button variant="ghost" size="icon" onClick={toggleRightPanel} title="Show task workspace" aria-label="Toggle task workspace">
                <PanelRight className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Right utility rail switches between task workspace and terminal. */}
          {showRightPanel && (
            <>
            {terminalVisible && <ResizeHandle target="terminal-width" onPointerDown={startResize} />}
            <aside className="eva-utility-rail flex min-h-0 shrink-0 flex-col" style={{ width: terminalVisible ? terminalWidth : rightPanelWidth }} aria-label={terminalVisible ? 'Terminal' : 'Task workspace'}>
              {terminalVisible ? (
                <>
                  <Suspense fallback={<LazyFallback className="h-56" />}>
                    <TerminalPanel height={terminalHeight} className="shrink-0 border border-zinc-200" />
                  </Suspense>
                  <ResizeHandle target="terminal-height" onPointerDown={startResize} />
                </>
              ) : <div className="task-workspace-note flex min-h-0 shrink-0 flex-col" style={taskNoteHeight ? { height: taskNoteHeight } : undefined}>
                {/* Panel header */}
                <div className="task-workspace-note__header flex items-center justify-between px-4 py-3">
                  <span className="text-xs font-semibold text-zinc-600">Workspace</span>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleRightPanel} title="Hide task workspace" aria-label="Toggle task workspace">
                    <PanelRightClose className="h-4 w-4" />
                  </Button>
                </div>

                <TaskWorkspacePanel />
              <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize task workspace height"
                  className="task-workspace-note__resize-edge task-workspace-note__resize-edge--bottom"
                  onPointerDown={(event) => startResize('task-note', event)}
                />
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize task workspace width"
                  className="task-workspace-note__resize-edge task-workspace-note__resize-edge--left"
                onPointerDown={(event) => startResize('right-panel', event)}
              />
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
    </ErrorBoundary>
  )
}

export default App
