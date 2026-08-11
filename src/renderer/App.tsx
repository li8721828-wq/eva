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
import { SymposiumWorkspace } from '@/components/symposium/SymposiumWorkspace'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { AgentManagerDialog } from '@/components/agents/AgentManagerDialog'
import { AppTitlebar } from '@/components/layout/AppTitlebar'
import { Button } from '@/components/ui/Button'
import { PanelRightClose, PanelRight, Loader2 } from 'lucide-react'

// Lazy-loaded heavy components
const CodeEditor = lazy(() => import('@/components/editor/CodeEditor').then(m => ({ default: m.CodeEditor })))
const TerminalPanel = lazy(() => import('@/components/terminal/TerminalPanel').then(m => ({ default: m.TerminalPanel })))
const FileExplorer = lazy(() => import('@/components/editor/FileExplorer').then(m => ({ default: m.FileExplorer })))

type ResizeTarget = 'sidebar' | 'right-panel' | 'explorer'

const SIDEBAR_MIN_WIDTH = 240
const SIDEBAR_MAX_WIDTH = 440
const RIGHT_PANEL_MIN_WIDTH = 300
const RIGHT_PANEL_MAX_WIDTH = 640
const EXPLORER_MIN_HEIGHT = 180
const EDITOR_MIN_HEIGHT = 180

function ResizeHandle({ target, onPointerDown }: { target: ResizeTarget; onPointerDown: (target: ResizeTarget, event: React.PointerEvent<HTMLDivElement>) => void }) {
  const vertical = target === 'explorer'
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-label={vertical ? 'Resize explorer and editor' : target === 'sidebar' ? 'Resize sidebar' : 'Resize explorer panel'}
      onPointerDown={(event) => onPointerDown(target, event)}
      className={vertical
        ? 'relative z-10 h-px shrink-0 cursor-row-resize touch-none bg-zinc-100 transition-colors hover:bg-violet-300 active:bg-violet-500 after:absolute after:-inset-x-2 after:-inset-y-2'
        : 'relative z-10 w-px shrink-0 cursor-col-resize touch-none bg-zinc-100 transition-colors hover:bg-violet-300 active:bg-violet-500 after:absolute after:-inset-x-2 after:-inset-y-2'}
    />
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
    currentFile,
    workspacePath,
    loadConfig,
    agentManagerOpen,
    setAgentManagerOpen,
    settingsOpen,
    currentView,
    sidebarCollapsed,
    sidebarWidth,
    rightPanelWidth,
    explorerHeight,
    setSidebarWidth,
    setRightPanelWidth,
    setExplorerHeight,
  } = useAppStore()

  const { loadConversations, currentConversationId, refreshConversation } = useChatStore()
  const { loadAgents } = useAgentStore()
  const { loadWorkspaces } = useWorkspaceStore()
  const [activeResize, setActiveResize] = useState<ResizeTarget | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const sidebarWidthRef = useRef(sidebarWidth)
  const rightPanelWidthRef = useRef(rightPanelWidth)

  useEffect(() => { sidebarWidthRef.current = sidebarWidth }, [sidebarWidth])
  useEffect(() => { rightPanelWidthRef.current = rightPanelWidth }, [rightPanelWidth])
  useEffect(() => () => resizeCleanupRef.current?.(), [])

  const startResize = useCallback((target: ResizeTarget, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeCleanupRef.current?.()
    const startX = event.clientX
    const startY = event.clientY
    const startSidebarWidth = sidebarWidthRef.current
    const startRightPanelWidth = rightPanelWidthRef.current
    const startExplorerHeight = explorerHeight
    setActiveResize(target)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = target === 'explorer' ? 'row-resize' : 'col-resize'

    const onMove = (moveEvent: PointerEvent) => {
      if (target === 'sidebar') {
        const available = window.innerWidth - (rightPanelVisible ? rightPanelWidthRef.current : 0) - 480
        setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, available, startSidebarWidth + moveEvent.clientX - startX)))
      } else if (target === 'right-panel') {
        const available = window.innerWidth - sidebarWidthRef.current - 480
        setRightPanelWidth(Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(RIGHT_PANEL_MAX_WIDTH, available, startRightPanelWidth - (moveEvent.clientX - startX))))
      } else {
        const maxHeight = Math.max(EXPLORER_MIN_HEIGHT, window.innerHeight - EDITOR_MIN_HEIGHT - 120)
        setExplorerHeight(Math.max(EXPLORER_MIN_HEIGHT, Math.min(maxHeight, startExplorerHeight + moveEvent.clientY - startY)))
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
          : ['explorerHeight', state.explorerHeight]
      void window.eva.config.set(key, value).catch(console.error)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    resizeCleanupRef.current = onUp
  }, [explorerHeight, rightPanelVisible, setExplorerHeight, setRightPanelWidth, setSidebarWidth])

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

  return (
    <ErrorBoundary>
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-white text-zinc-900" data-resizing={activeResize || undefined}>
      <AppTitlebar />
      <div className="flex min-h-0 flex-1">
      {/* Left Sidebar */}
      <Sidebar style={!sidebarCollapsed ? { width: sidebarWidth } : undefined} />
      {!sidebarCollapsed && <ResizeHandle target="sidebar" onPointerDown={startResize} />}

      {/* Main Workspace */}
      <div className="flex flex-1 flex-col min-w-0">
        {settingsOpen ? (
          <SettingsDialog />
        ) : (
          <>
          <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-w-0">
            {currentView === 'artifacts' ? <TaskArtifactCenter /> : currentView === 'symposium' ? <SymposiumWorkspace /> : <ChatPanel className="h-full" />}
          </div>

          {/* Right Panel Toggle */}
          {!rightPanelVisible && (
            <div className="flex flex-col items-center border-l border-zinc-200 bg-white py-2 px-1">
              <Button variant="ghost" size="icon" onClick={toggleRightPanel} title="Show panel" aria-label="Toggle file panel">
                <PanelRight className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Right Panel (File Explorer + Editor) */}
          {rightPanelVisible && (
            <>
            <ResizeHandle target="right-panel" onPointerDown={startResize} />
            <div className="flex shrink-0 flex-col" style={{ width: rightPanelWidth }}>
              {/* Panel header */}
              <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
                <span className="text-xs font-medium text-zinc-500">Explorer</span>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleRightPanel} title="Hide panel" aria-label="Toggle file panel">
                  <PanelRightClose className="h-4 w-4" />
                </Button>
              </div>

              {/* File Explorer (top half) */}
              <div className="min-h-0 shrink-0" style={{ height: explorerHeight }}>
                <Suspense fallback={<LazyFallback className="h-full" />}>
                  <FileExplorer className="h-full" />
                </Suspense>
              </div>

              <ResizeHandle target="explorer" onPointerDown={startResize} />

              {/* Code Editor (bottom half) */}
              <div className="min-h-0 flex-1">
                <Suspense fallback={<LazyFallback className="h-full" />}>
                  <CodeEditor
                    className="h-full"
                    filePath={currentFile?.path}
                    content={currentFile?.content}
                    language={currentFile?.language}
                  />
                </Suspense>
              </div>
            </div>
            </>
          )}
        </div>

        {/* Terminal Panel */}
        {terminalVisible && (
          <Suspense fallback={<LazyFallback className="h-48" />}>
            <TerminalPanel />
          </Suspense>
        )}
          </>
        )}
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
