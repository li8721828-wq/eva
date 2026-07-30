import React, { useEffect, lazy, Suspense } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import { useStreaming } from '@/hooks/use-streaming'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { TaskArtifactCenter } from '@/components/tasks/TaskArtifactCenter'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { AgentManagerDialog } from '@/components/agents/AgentManagerDialog'
import { Separator } from '@/components/ui/Separator'
import { Button } from '@/components/ui/Button'
import { PanelRightClose, PanelRight, Loader2 } from 'lucide-react'

// Lazy-loaded heavy components
const CodeEditor = lazy(() => import('@/components/editor/CodeEditor').then(m => ({ default: m.CodeEditor })))
const TerminalPanel = lazy(() => import('@/components/terminal/TerminalPanel').then(m => ({ default: m.TerminalPanel })))
const FileExplorer = lazy(() => import('@/components/editor/FileExplorer').then(m => ({ default: m.FileExplorer })))

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
  } = useAppStore()

  const { loadConversations, currentConversationId, selectConversation } = useChatStore()
  const { loadAgents } = useAgentStore()
  const { loadWorkspaces } = useWorkspaceStore()

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
    if (conversationId === currentConversationId) void selectConversation(conversationId)
  }), [currentConversationId, loadConversations, selectConversation])

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
    <div className="flex h-screen w-screen overflow-hidden bg-white text-zinc-900">
      {/* Left Sidebar */}
      <Sidebar />

      {/* Main Workspace */}
      <div className="flex flex-1 flex-col min-w-0">
        {settingsOpen ? (
          <SettingsDialog />
        ) : (
          <>
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-w-0">
            {currentView === 'artifacts' ? <TaskArtifactCenter /> : <ChatPanel className="h-full" />}
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
            <div className="flex w-[320px] shrink-0 flex-col border-l border-zinc-200">
              {/* Panel header */}
              <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
                <span className="text-xs font-medium text-zinc-500">Explorer</span>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleRightPanel} title="Hide panel" aria-label="Toggle file panel">
                  <PanelRightClose className="h-4 w-4" />
                </Button>
              </div>

              {/* File Explorer (top half) */}
              <div className="h-1/2 min-h-0">
                <Suspense fallback={<LazyFallback className="h-full" />}>
                  <FileExplorer className="h-full" />
                </Suspense>
              </div>

              <Separator />

              {/* Code Editor (bottom half) */}
              <div className="h-1/2 min-h-0">
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
    </ErrorBoundary>
  )
}

export default App
