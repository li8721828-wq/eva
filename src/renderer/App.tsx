import React, { useEffect, useCallback, lazy, Suspense, useState } from 'react'
import type { SpecTemplate } from '../shared/types/spec'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { useTaskStore } from '@/stores/use-task-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import { useStreaming } from '@/hooks/use-streaming'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Sidebar } from '@/components/sidebar/Sidebar'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { TaskBoard } from '@/components/task-board/TaskBoard'
import { GoalInput } from '@/components/goal/GoalInput'
import { GoalProgress } from '@/components/goal/GoalProgress'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { AgentManagerDialog } from '@/components/agents/AgentManagerDialog'
import { SpecSelector } from '@/components/specs/SpecSelector'
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
    workMode,
    rightPanelVisible,
    toggleRightPanel,
    setRightPanelVisible,
    terminalVisible,
    toggleTerminal,
    currentFile,
    workspacePath,
    loadConfig,
    agentManagerOpen,
    setAgentManagerOpen,
    specSelectorOpen,
    setSpecSelectorOpen,
    setWorkMode,
  } = useAppStore()

  const { loadConversations, createConversation, setInputText } = useChatStore()
  const { loadAgents } = useAgentStore()
  const { loadWorkspaces } = useWorkspaceStore()
  const { startExpertTask, startGoal } = useTaskStore()

  // Initialize streaming listeners
  useStreaming()

  // Track window width for responsive layout
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)

  // Load data on mount
  useEffect(() => {
    loadConfig()
    loadConversations()
    loadAgents()
    loadWorkspaces()
  }, [])

  useEffect(() => window.eva.menu.onToggleTerminal(toggleTerminal), [toggleTerminal])

  // Responsive: auto-hide right panel on small windows
  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth
      setWindowWidth(width)
      if (width < 1000 && rightPanelVisible) {
        setRightPanelVisible(false)
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [rightPanelVisible, setRightPanelVisible])

  const showTaskBoard = workMode === 'expert'
  const showGoalMode = workMode === 'goal'
  const goalProgress = useTaskStore((s) => s.goalProgress)

  const handleSelectTemplate = useCallback(
    async (template: SpecTemplate, params: Record<string, string>) => {
      // Build the instantiated prompt by replacing placeholders in each step
      const sections = template.steps.map((step) => {
        let prompt = step.prompt
        for (const [key, value] of Object.entries(params)) {
          prompt = prompt.replaceAll(`{{${key}}}`, value || '')
        }
        return `## ${step.title}\n${step.description}\n\n${prompt}`
      })
      const fullPrompt = `# ${template.name}\n${template.description}\n\n${sections.join('\n\n---\n\n')}`

      const mode = template.recommendedMode

      if (mode === 'normal') {
        // Create a new conversation and send the prompt as the first message
        const conv = await createConversation(undefined, 'normal')
        setInputText(fullPrompt)
        // Use setTimeout to allow state to settle, then send
        setTimeout(() => {
          useChatStore.getState().sendMessage()
        }, 200)
      } else if (mode === 'expert') {
        // Switch to expert mode and start an expert task
        setWorkMode('expert')
        setTimeout(() => {
          startExpertTask(fullPrompt)
        }, 200)
      } else if (mode === 'goal') {
        // Switch to goal mode and start a goal
        setWorkMode('goal')
        const agentId = useAgentStore.getState().selectedAgentId || ''
        const conv = await createConversation(agentId, 'goal')
        setTimeout(() => {
          startGoal(fullPrompt, agentId, conv.id)
        }, 200)
      }
    },
    [createConversation, setInputText, setWorkMode, startExpertTask, startGoal]
  )

  return (
    <ErrorBoundary>
    <div className="flex h-screen w-screen overflow-hidden bg-white text-zinc-900">
      {/* Left Sidebar */}
      <Sidebar />

      {/* Main Workspace */}
      <div className="flex flex-1 flex-col min-w-0">
        <div className="flex flex-1 min-h-0">
          {(showTaskBoard || showGoalMode) ? (
            <>
              {/* Left panel: Task Board or Goal UI */}
              <div className={`${windowWidth < 800 ? 'w-[300px]' : 'w-[380px]'} min-w-[280px] shrink-0 border-r border-zinc-200`}>
                {showTaskBoard && <TaskBoard className="h-full" />}
                {showGoalMode && (
                  goalProgress
                    ? <GoalProgress className="h-full" />
                    : <GoalInput className="h-full" />
                )}
              </div>
              {/* Chat Panel (right portion of main area) */}
              <div className="flex-1 min-w-0">
                <ChatPanel className="h-full" />
              </div>
            </>
          ) : (
            /* Full-width Chat Panel */
            <div className="flex-1 min-w-0">
              <ChatPanel className="h-full" />
            </div>
          )}

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
      </div>

      {/* Settings Dialog */}
      <SettingsDialog />

      {/* Agent Manager Dialog */}
      <AgentManagerDialog
        open={agentManagerOpen}
        onOpenChange={setAgentManagerOpen}
      />

      {/* Spec Template Selector Dialog */}
      <SpecSelector
        open={specSelectorOpen}
        onOpenChange={setSpecSelectorOpen}
        onSelectTemplate={handleSelectTemplate}
      />
    </div>
    </ErrorBoundary>
  )
}

export default App
