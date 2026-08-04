import React, { useEffect, useMemo, useState } from 'react'
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
import { Bot, AlertCircle, ShieldAlert, Terminal, X, UsersRound, Square, GitBranch, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { useSymposiumStore } from '@/stores/use-symposium-store'
import type { GitRepositoryStatus } from '../../../shared/types'
import { SYMPOSIUM_TOOL_OPTIONS } from '../../../shared/types/symposium'

export interface ChatPanelProps {
  className?: string
}

export function ChatPanel({ className }: ChatPanelProps) {
  const { conversations, currentConversationId, error, setError, setConversationGitBranch, setConversationSymposium } = useChatStore()
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
  const [gitStatus, setGitStatus] = useState<GitRepositoryStatus | null>(null)
  const [isSwitchingGitBranch, setIsSwitchingGitBranch] = useState(false)
  const [symposiumCapabilitiesOpen, setSymposiumCapabilitiesOpen] = useState(false)
  const [symposiumToolDraft, setSymposiumToolDraft] = useState<string[]>([])
  const [savingSymposiumCapabilities, setSavingSymposiumCapabilities] = useState(false)

  useEffect(() => {
    setSymposiumCapabilitiesOpen(false)
    setSymposiumToolDraft(currentConversation?.symposium?.tools || [])
  }, [currentConversationId, currentConversation?.symposium?.tools])

  useEffect(() => {
    let cancelled = false
    if (!currentConversationId) {
      setGitStatus(null)
      return () => { cancelled = true }
    }

    void window.eva.git.status(currentConversationId)
      .then((status) => { if (!cancelled) setGitStatus(status) })
      .catch((loadError) => {
        if (!cancelled) setGitStatus(null)
        console.error('Failed to load Git status:', loadError)
      })

    return () => { cancelled = true }
  }, [currentConversationId, currentConversation?.gitBranch, currentConversation?.workspacePath])

  const gitBranchOptions = useMemo(() => {
    if (!gitStatus?.isRepository) return []
    return gitStatus.branches.map((branch) => ({
      value: branch.name,
      label: branch.checkedOutPath ? `${branch.name} (in use)` : branch.name,
      disabled: Boolean(branch.checkedOutPath),
    }))
  }, [gitStatus])

  const handleGitBranchChange = async (branch: string) => {
    if (!currentConversation || !branch || branch === currentConversation.gitBranch) return
    setIsSwitchingGitBranch(true)
    try {
      await setConversationGitBranch(currentConversation.id, branch)
      setGitStatus(await window.eva.git.status(currentConversation.id))
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : 'Could not switch Git branch.')
    } finally {
      setIsSwitchingGitBranch(false)
    }
  }

  const toggleSymposiumTool = (toolId: string) => {
    setSymposiumToolDraft((current) => {
      if (current.includes(toolId)) {
        const next = current.filter((id) => id !== toolId)
        return toolId === 'read_file' ? next.filter((id) => id !== 'write_file') : next
      }
      return toolId === 'write_file' && !current.includes('read_file')
        ? [...current, 'read_file', toolId]
        : [...current, toolId]
    })
  }

  const saveSymposiumCapabilities = async () => {
    if (!currentConversation?.symposium) return
    setSavingSymposiumCapabilities(true)
    try {
      await setConversationSymposium(currentConversation.id, { ...currentConversation.symposium, tools: symposiumToolDraft })
      setSymposiumCapabilitiesOpen(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save Symposium capabilities.')
    } finally {
      setSavingSymposiumCapabilities(false)
    }
  }

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
          {currentConversation && (
            <div className="flex items-center gap-1.5">
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
              <div className="w-[156px]">
                <Select
                  value={gitStatus?.isRepository ? (currentConversation.gitBranch || gitStatus.currentBranch || '') : ''}
                  onChange={(event) => void handleGitBranchChange(event.target.value)}
                  options={gitStatus?.isRepository
                    ? gitBranchOptions
                    : [{ value: '', label: gitStatus?.message || 'Checking Git repository...' }]}
                  disabled={!gitStatus?.isRepository || symposiumRunning || isSwitchingGitBranch || gitBranchOptions.length === 0}
                  className="h-8 border-transparent bg-transparent text-xs font-medium text-zinc-700 shadow-none hover:bg-zinc-50 focus:border-zinc-300 focus:bg-white focus:shadow-sm focus:ring-0 focus-visible:border-zinc-300 focus-visible:ring-0"
                  aria-label="Git branch for this conversation"
                  title={gitStatus?.isRepository ? 'Git branch for this conversation' : gitStatus?.message || 'Checking Git repository'}
                />
              </div>
            </div>
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
        <>
            <div className="flex items-center justify-between gap-4 border-b border-violet-100 bg-violet-50/45 px-6 py-2.5 text-xs text-zinc-600">
              <div className="min-w-0 truncate"><span className="font-medium text-violet-800">Shared model discussion</span><span className="ml-2">{displayedSymposiumParticipants.join(' / ') || 'Model seats'}</span><span className="ml-2 text-zinc-500">{symposium.tools?.length ? `${symposium.tools.length} capabilities granted` : 'No model tools granted'}</span>{symposiumRunning && symposiumRuntime?.agentName ? <span className="ml-2 text-violet-600">{symposiumRuntime.agentName} is responding</span> : <span className="ml-2 text-zinc-500">Your next message invites every model to respond.</span>}</div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-violet-700 hover:bg-violet-100 hover:text-violet-800" onClick={() => setSymposiumCapabilitiesOpen((open) => !open)} title="Choose which tools every model can use"><ShieldCheck className="h-3.5 w-3.5" />Model capabilities</Button>
                {symposiumRunning && currentConversationId && <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => void window.eva.symposium.abort(currentConversationId)}><Square className="h-3.5 w-3.5" />Stop discussion</Button>}
              </div>
            </div>
            {symposiumCapabilitiesOpen && (
              <div className="border-b border-zinc-200 bg-white px-6 py-4">
                <div className="flex items-start justify-between gap-5"><div><p className="text-sm font-medium text-zinc-900">Model capabilities</p><p className="mt-1 text-xs leading-5 text-zinc-500">Applies to every model in this discussion. While a response is running, changes take effect from the next message. Conversation file permissions remain in force.</p></div><div className="flex items-center gap-2"><Button variant="ghost" size="sm" onClick={() => setSymposiumCapabilitiesOpen(false)}>Cancel</Button><Button size="sm" disabled={savingSymposiumCapabilities} onClick={() => void saveSymposiumCapabilities()}>{savingSymposiumCapabilities ? 'Saving...' : 'Save capabilities'}</Button></div></div>
              <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {SYMPOSIUM_TOOL_OPTIONS.map((tool) => {
                  const selected = symposiumToolDraft.includes(tool.id)
                  return <label key={tool.id} className={cn('flex cursor-pointer gap-2.5 rounded-md border px-3 py-2.5', selected ? 'border-violet-200 bg-violet-50/70' : 'border-zinc-200 hover:border-zinc-300')}><input type="checkbox" checked={selected} onChange={() => toggleSymposiumTool(tool.id)} className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-violet-600 focus:ring-violet-500" /><span className="min-w-0"><span className="text-xs font-medium text-zinc-800">{tool.label}</span><span className="ml-1.5 text-[10px] uppercase tracking-wide text-zinc-400">{tool.group}</span><span className="mt-0.5 block text-[11px] leading-4 text-zinc-500">{tool.description}</span></span></label>
                })}
              </div>
            </div>
          )}
        </>
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
