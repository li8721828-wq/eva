import React, { useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { useAppStore } from '@/stores/use-app-store'
import { EMPTY_EXPERT_TASK, useTaskStore } from '@/stores/use-task-store'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { TeamCollaborationPanel } from './TeamCollaborationPanel'
import { ExecutionMonitor } from './ExecutionMonitor'
import { Bot, AlertCircle, ShieldAlert, Terminal, X, UsersRound, Square, GitBranch, ShieldCheck, Pin } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { useSymposiumStore } from '@/stores/use-symposium-store'
import type { GitRepositoryStatus } from '../../../shared/types'
import { SYMPOSIUM_TOOL_OPTIONS } from '../../../shared/types/symposium'
import type { QqRemoteStatus } from '../../../shared/types/qq'

export interface ChatPanelProps {
  className?: string
}

const QQ_CONNECTION_PRESENTATION: Record<QqRemoteStatus['state'], { label: string; className: string }> = {
  connected: { label: '已连接', className: 'bg-emerald-500' },
  connecting: { label: '连接中', className: 'bg-amber-400 animate-pulse' },
  disconnected: { label: '未连接', className: 'bg-zinc-400' },
  disabled: { label: '未启用', className: 'bg-zinc-400' },
  error: { label: '连接异常', className: 'bg-rose-500' },
}

export function ChatPanel({ className }: ChatPanelProps) {
  const { conversations, currentConversationId, error, setError, setConversationGitBranch, setConversationSymposium } = useChatStore()
  const { agents } = useAgentStore()
  const { workMode, terminalVisible, toggleTerminal } = useAppStore()
  const expertTask = useTaskStore((state) => state.expertTasks[currentConversationId || ''] || EMPTY_EXPERT_TASK)
  const { currentPlan, isRunning: isTaskRunning, recoveryStatus, summary: expertSummary } = expertTask

  const currentConversation = conversations.find((conversation) => conversation.id === currentConversationId)
  const symposiumRuntime = useSymposiumStore((state) => currentConversationId ? state.runtimes[currentConversationId] : undefined)
  const symposium = currentConversation?.symposium
  const symposiumRunning = symposiumRuntime?.status === 'running'
  const symposiumSeats = symposium?.participants || []
  const symposiumParticipants = symposiumSeats.map((participant) => `${participant.providerName} / ${participant.modelName} @${participant.handle}`)
  const legacySymposiumParticipants = symposium?.participantIds
    ?.map((id) => agents.find((candidate) => candidate.id === id)?.name)
    .filter((name): name is string => Boolean(name)) || []
  const displayedSymposiumParticipants = symposiumParticipants.length ? symposiumParticipants : legacySymposiumParticipants
  const [gitStatus, setGitStatus] = useState<GitRepositoryStatus | null>(null)
  const [isSwitchingGitBranch, setIsSwitchingGitBranch] = useState(false)
  const [symposiumCapabilitiesOpen, setSymposiumCapabilitiesOpen] = useState(false)
  const [symposiumToolDrafts, setSymposiumToolDrafts] = useState<Record<string, string[]>>({})
  const [symposiumMemoryDraft, setSymposiumMemoryDraft] = useState({ objective: '', agreements: '', openQuestions: '', actionItems: '', pinned: true })
  const [savingSymposiumCapabilities, setSavingSymposiumCapabilities] = useState(false)
  const [qqStatus, setQqStatus] = useState<QqRemoteStatus | null>(null)

  useEffect(() => {
    setSymposiumCapabilitiesOpen(false)
    const nextSymposium = currentConversation?.symposium
    setSymposiumToolDrafts(Object.fromEntries((nextSymposium?.participants || []).map((participant) => [participant.id, participant.tools ?? nextSymposium?.tools ?? []])))
    setSymposiumMemoryDraft({
      objective: nextSymposium?.memory?.objective || nextSymposium?.topic || '',
      agreements: (nextSymposium?.memory?.agreements || []).join('\n'),
      openQuestions: (nextSymposium?.memory?.openQuestions || []).join('\n'),
      actionItems: (nextSymposium?.memory?.actionItems || []).join('\n'),
      pinned: nextSymposium?.memory?.pinned ?? true,
    })
  }, [currentConversationId, currentConversation?.symposium])

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

  useEffect(() => {
    if (currentConversation?.channel !== 'qq') {
      setQqStatus(null)
      return
    }

    let cancelled = false
    const refresh = () => void window.eva.qqRemote.getStatus()
      .then((status) => { if (!cancelled) setQqStatus(status) })
      .catch(() => {
        if (!cancelled) setQqStatus({ state: 'error', message: 'Unable to check the QQ channel connection.' })
      })

    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [currentConversation?.channel, currentConversationId])

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

  const toggleSymposiumTool = (participantId: string, toolId: string) => {
    setSymposiumToolDrafts((current) => {
      const currentTools = current[participantId] || []
      const next = (() => {
      if (currentTools.includes(toolId)) {
        const next = currentTools.filter((id) => id !== toolId)
        return toolId === 'read_file' ? next.filter((id) => id !== 'write_file' && id !== 'edit_file') : next
      }
      return (toolId === 'write_file' || toolId === 'edit_file') && !currentTools.includes('read_file')
        ? [...currentTools, 'read_file', toolId]
        : [...currentTools, toolId]
      })()
      return { ...current, [participantId]: next }
    })
  }

  const memoryItems = (value: string) => value.split('\n').map((item) => item.trim()).filter(Boolean)

  const saveSymposiumCapabilities = async () => {
    if (!currentConversation?.symposium) return
    setSavingSymposiumCapabilities(true)
    try {
      const participants = (currentConversation.symposium.participants || []).map((participant) => ({
        ...participant,
        tools: symposiumToolDrafts[participant.id] || [],
      }))
      const hasWriter = participants.some((participant) => participant.tools?.includes('write_file') || participant.tools?.includes('edit_file'))
      if (hasWriter && !currentConversation.workspacePath) throw new Error('File editing requires this Symposium to belong to a workspace.')
      await setConversationSymposium(currentConversation.id, {
        ...currentConversation.symposium,
        participants,
        sharedDocument: undefined,
        memory: {
          objective: symposiumMemoryDraft.objective.trim() || currentConversation.symposium.topic,
          agreements: memoryItems(symposiumMemoryDraft.agreements),
          openQuestions: memoryItems(symposiumMemoryDraft.openQuestions),
          actionItems: memoryItems(symposiumMemoryDraft.actionItems),
          pinned: symposiumMemoryDraft.pinned,
          updatedAt: Date.now(),
        },
      })
      setSymposiumCapabilitiesOpen(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save Symposium capabilities.')
    } finally {
      setSavingSymposiumCapabilities(false)
    }
  }

  return (
    <div className={cn('eva-chat-surface flex h-full flex-col', className)}>
      {/* Header */}
      <div className="eva-chat-header flex h-14 items-center justify-between gap-4 border-b px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate text-base font-semibold text-zinc-800" title={currentConversation?.title || 'New conversation'}>
            {currentConversation?.title || 'New conversation'}
          </h1>
          {qqStatus && (() => {
            const status = QQ_CONNECTION_PRESENTATION[qqStatus.state]
            return (
              <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-zinc-500" title={qqStatus.message}>
                <span className={cn('h-1.5 w-1.5 rounded-full', status.className)} aria-hidden="true" />
                {status.label}
              </span>
            )
          })()}
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
        </div>
      </div>

      {symposium && (
        <>
              <div className="flex items-center justify-between gap-4 border-b border-violet-100 bg-violet-50/45 px-6 py-2.5 text-xs text-zinc-600">
              <div className="min-w-0 truncate"><span className="font-medium text-violet-800">Shared model discussion</span><span className="ml-2">{displayedSymposiumParticipants.join(' / ') || 'Model seats'}</span><span className="ml-2 text-zinc-500">Independent seat permissions</span>{symposiumRunning && symposiumRuntime?.agentName ? <span className="ml-2 text-violet-600">{symposiumRuntime.agentName} is responding</span> : <span className="ml-2 text-zinc-500">Your next message invites every model to respond.</span>}</div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-violet-700 hover:bg-violet-100 hover:text-violet-800" onClick={() => setSymposiumCapabilitiesOpen((open) => !open)} title="Choose which tools every model can use"><ShieldCheck className="h-3.5 w-3.5" />Model capabilities</Button>
                {symposiumRunning && currentConversationId && <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => void window.eva.symposium.abort(currentConversationId)}><Square className="h-3.5 w-3.5" />Stop discussion</Button>}
              </div>
            </div>
            {symposiumCapabilitiesOpen && (
              <div className="border-b border-zinc-200 bg-white px-6 py-4">
                <div className="flex items-start justify-between gap-5"><div><p className="text-sm font-medium text-zinc-900">Discussion controls</p><p className="mt-1 text-xs leading-5 text-zinc-500">Each model seat has its own atomic tool grant. Changes made while a response is running apply from the next message.</p></div><div className="flex items-center gap-2"><Button variant="ghost" size="sm" onClick={() => setSymposiumCapabilitiesOpen(false)}>Cancel</Button><Button size="sm" disabled={savingSymposiumCapabilities} onClick={() => void saveSymposiumCapabilities()}>{savingSymposiumCapabilities ? 'Saving...' : 'Save changes'}</Button></div></div>
                <div className="mt-5 grid gap-3 xl:grid-cols-2">
                  {symposiumSeats.map((participant) => <section key={participant.id} className="rounded-lg border border-zinc-200 p-3.5"><div className="flex items-baseline justify-between gap-3"><p className="truncate text-sm font-medium text-zinc-900">{participant.modelName}</p><span className="shrink-0 text-[11px] text-zinc-400">{participant.providerName}</span></div><p className="mt-1 truncate font-mono text-[11px] text-violet-700">@{participant.handle}</p><div className="mt-3 flex flex-wrap gap-1.5">{SYMPOSIUM_TOOL_OPTIONS.map((tool) => { const selected = (symposiumToolDrafts[participant.id] || []).includes(tool.id); return <label key={tool.id} className={cn('cursor-pointer rounded-md px-2 py-1 text-[11px] transition-colors', selected ? 'bg-violet-100 text-violet-800' : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200')}><input type="checkbox" className="sr-only" checked={selected} onChange={() => toggleSymposiumTool(participant.id, tool.id)} />{tool.label}</label> })}</div></section>)}
                </div>
                <div className="mt-5 border-t border-zinc-100 pt-5"><section><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Pin className="h-4 w-4 text-violet-600" /><p className="text-sm font-medium text-zinc-900">Pinned discussion brief</p></div><label className="flex items-center gap-1.5 text-xs text-zinc-600"><input type="checkbox" checked={symposiumMemoryDraft.pinned} onChange={(event) => setSymposiumMemoryDraft((draft) => ({ ...draft, pinned: event.target.checked }))} className="h-4 w-4 rounded border-zinc-300 text-violet-600" />Pin</label></div><p className="mt-1 text-xs leading-5 text-zinc-500">This durable context is inserted ahead of the discussion transcript for every seat.</p></section></div>
                <div className="mt-3 grid gap-3 lg:grid-cols-2"><label className="text-xs font-medium text-zinc-700">Objective<textarea value={symposiumMemoryDraft.objective} onChange={(event) => setSymposiumMemoryDraft((draft) => ({ ...draft, objective: event.target.value }))} className="mt-1.5 min-h-20 w-full resize-y rounded-md border border-zinc-200 px-3 py-2 text-sm font-normal outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100" /></label><label className="text-xs font-medium text-zinc-700">Agreements (one per line)<textarea value={symposiumMemoryDraft.agreements} onChange={(event) => setSymposiumMemoryDraft((draft) => ({ ...draft, agreements: event.target.value }))} className="mt-1.5 min-h-20 w-full resize-y rounded-md border border-zinc-200 px-3 py-2 text-sm font-normal outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100" /></label><label className="text-xs font-medium text-zinc-700">Open questions (one per line)<textarea value={symposiumMemoryDraft.openQuestions} onChange={(event) => setSymposiumMemoryDraft((draft) => ({ ...draft, openQuestions: event.target.value }))} className="mt-1.5 min-h-20 w-full resize-y rounded-md border border-zinc-200 px-3 py-2 text-sm font-normal outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100" /></label><label className="text-xs font-medium text-zinc-700">Action items (one per line)<textarea value={symposiumMemoryDraft.actionItems} onChange={(event) => setSymposiumMemoryDraft((draft) => ({ ...draft, actionItems: event.target.value }))} className="mt-1.5 min-h-20 w-full resize-y rounded-md border border-zinc-200 px-3 py-2 text-sm font-normal outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100" /></label></div>
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
