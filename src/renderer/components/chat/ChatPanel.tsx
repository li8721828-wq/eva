import React from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { EMPTY_EXPERT_TASK, useTaskStore } from '@/stores/use-task-store'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { TeamCollaborationPanel } from './TeamCollaborationPanel'
import { ExecutionMonitor } from './ExecutionMonitor'
import { Bot, AlertCircle, ShieldAlert, Terminal, X, UsersRound, Square } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useSymposiumStore } from '@/stores/use-symposium-store'

export interface ChatPanelProps {
  className?: string
}

export function ChatPanel({ className }: ChatPanelProps) {
  const { conversations, currentConversationId, error, setError } = useChatStore()
  const { workMode, terminalVisible, toggleTerminal } = useAppStore()
  const { agents, getSelectedAgent } = useAgentStore()
  const expertTask = useTaskStore((state) => state.expertTasks[currentConversationId || ''] || EMPTY_EXPERT_TASK)
  const { currentPlan, isRunning: isTaskRunning, recoveryStatus, summary: expertSummary } = expertTask

  const currentConversation = conversations.find((conversation) => conversation.id === currentConversationId)
  const agent = agents.find((candidate) => candidate.id === currentConversation?.agentId) || getSelectedAgent()
  const symposiumRuntime = useSymposiumStore((state) => currentConversationId ? state.runtimes[currentConversationId] : undefined)
  const symposium = currentConversation?.symposium
  const symposiumRunning = symposiumRuntime?.status === 'running'
  const symposiumParticipants = symposium?.participants?.map((participant) => `${participant.providerName} / ${participant.modelName} @${participant.handle}`) || []
  const legacySymposiumParticipants = symposium?.participantIds
    ?.map((id) => agents.find((candidate) => candidate.id === id)?.name)
    .filter((name): name is string => Boolean(name)) || []
  const displayedSymposiumParticipants = symposiumParticipants.length ? symposiumParticipants : legacySymposiumParticipants

  const modeLabels: Record<string, string> = {
    normal: 'Auto',
    expert: 'Team',
    goal: 'Goal',
  }

  return (
    <div className={cn('flex flex-col h-full bg-white', className)}>
      {/* Header */}
      <div className="flex h-14 items-center justify-between border-b border-zinc-200 px-6">
        <div className="flex items-center gap-2.5">
          <Bot className="h-4 w-4 text-violet-500" />
          <span className="text-base font-medium text-zinc-800">
            {currentConversationId ? 'Conversation' : 'New Chat'}
          </span>
          <span className="text-sm text-zinc-500">{symposium ? 'Model Symposium' : agent?.name || 'Coding Assistant'}</span>
          {symposium && <span className="inline-flex items-center gap-1 text-xs text-violet-600"><UsersRound className="h-3.5 w-3.5" />Symposium</span>}
        </div>
        <div className="flex items-center gap-2">
          {currentConversationId && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={toggleTerminal}
              title={terminalVisible ? 'Hide terminal' : 'Open terminal for this conversation workspace'}
              aria-label={terminalVisible ? 'Hide terminal' : 'Open terminal for this conversation workspace'}
            >
              <Terminal className="h-4 w-4" />
            </Button>
          )}
          {(currentConversation?.permissionLevel === 'full-access' || (!currentConversation?.permissionLevel && currentConversation?.accessScope === 'full')) && (
            <Badge variant="warning" className="gap-1" title="This conversation can access the full local filesystem">
              <ShieldAlert className="h-3 w-3" />
              Full access
            </Badge>
          )}
          <Badge variant={workMode === 'normal' ? 'default' : 'primary'}>
            {modeLabels[workMode]}
          </Badge>
        </div>
      </div>

      {symposium && (
        <div className="flex items-center justify-between gap-4 border-b border-violet-100 bg-violet-50/45 px-6 py-2.5 text-xs text-zinc-600">
          <div className="min-w-0 truncate"><span className="font-medium text-violet-800">Shared model discussion</span><span className="ml-2">{displayedSymposiumParticipants.join(' / ') || 'Model seats'}</span>{symposiumRunning && symposiumRuntime?.agentName ? <span className="ml-2 text-violet-600">{symposiumRuntime.agentName} is responding</span> : <span className="ml-2 text-zinc-500">Your next message invites every model to respond.</span>}</div>
          {symposiumRunning && currentConversationId && <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => void window.eva.symposium.abort(currentConversationId)}><Square className="h-3.5 w-3.5" />Stop discussion</Button>}
        </div>
      )}

      {workMode === 'expert' && (isTaskRunning || currentPlan) && (
        <div className="flex items-center gap-3 border-b border-violet-100 bg-violet-50/60 px-6 py-2 text-xs text-zinc-600">
          <Bot className={cn('h-3.5 w-3.5 text-violet-600', isTaskRunning && 'animate-pulse')} />
          <span className="font-medium text-violet-800">Expert Team</span>
          <span className="truncate">
            {isTaskRunning
              ? `Working on ${currentPlan?.subtasks.filter((task) => task.status === 'in_progress').length || 0} task(s)`
              : `${currentPlan?.subtasks.filter((task) => task.status === 'completed').length || 0}/${currentPlan?.subtasks.length || 0} tasks completed`}
          </span>
        </div>
      )}

      {workMode === 'expert' && recoveryStatus === 'interrupted' && (
        <div className="flex items-center gap-3 border-b border-amber-100 bg-amber-50/60 px-6 py-2 text-xs text-amber-800">
          <AlertCircle className="h-3.5 w-3.5" />
          <span className="truncate">{expertSummary || 'Eva was closed before the team task finished. Completed subtasks are retained.'}</span>
        </div>
      )}

      <TeamCollaborationPanel />

      {/* Error Banner */}
      {error && (
        <div className="mx-4 mt-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="shrink-0 p-0.5 rounded text-red-400 hover:text-red-600 hover:bg-red-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Messages */}
      <MessageList className="flex-1" />

      <ExecutionMonitor />

      {/* Input */}
      <InputBar />
    </div>
  )
}
