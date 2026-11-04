import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Circle,
  CircleMinus,
  CircleX,
  ExternalLink,
  FileText,
  FolderOpen,
  ListTodo,
  Loader2,
  PanelTopOpen,
  Play,
  Square,
  Target,
} from 'lucide-react'
import type { GoalStepAttempt, TaskArtifactItem, TaskRunSnapshot, TaskRunStatus, TaskStatus, TeamEvent } from '../../../shared/types/task'
import type { ToolCall } from '../../../shared/types/conversation'
import type { ActivePlan } from '../../../shared/types/active-plan'
import { getModelInputBudgetTokens } from '../../../shared/constants'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { FileExplorer } from '@/components/editor/FileExplorer'
import { PlanChecklist } from '@/components/chat/PlanChecklist'
import { buildPlanChecklist } from '../../../shared/plan-checklist'
import { workspaceText } from '@/lib/workspace-copy'
import { shellCopy } from '@/lib/shell-copy'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { EMPTY_EXPERT_TASK, EMPTY_GOAL_TASK, useTaskStore } from '@/stores/use-task-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import type { RequirementDocument, RequirementRun } from '../../../shared/types/requirement-engineering'
import { ProjectKnowledgePanel } from '@/components/settings/ProjectKnowledgePanel'
import { PurposePanel } from './PurposePanel'
import { NativeAgentView } from '@/components/chat/NativeAgentView'

type StepItem = {
  id: string
  title: string
  detail?: string
  status: TaskStatus
  result?: string
  toolCalls?: ToolCall[]
  agentConversationId?: string
  attempt?: number
  maxAttempts?: number
  attempts?: GoalStepAttempt[]
  assignedAgentName?: string
}

const activeStatuses: TaskRunStatus[] = ['queued', 'running', 'paused']

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

function StepStatusIcon({ status, paused = false }: { status: TaskStatus | TaskRunStatus; paused?: boolean }) {
  if (status === 'completed') return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
  if (status === 'failed') return <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
  if (status === 'cancelled') return <CircleMinus className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
  if (status === 'interrupted') return <Square className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
  if (paused && (status === 'in_progress' || status === 'running')) return <Square className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-400" />
  if (status === 'in_progress' || status === 'running') return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-violet-500" />
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-300" />
}

function stepStatusLabel(status: TaskStatus | TaskRunStatus): string {
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Failed'
  if (status === 'cancelled') return 'Cancelled'
  if (status === 'interrupted') return 'Stopped'
  if (status === 'in_progress' || status === 'running') return 'In progress'
  return 'Waiting'
}

function snapshotSteps(snapshot: TaskRunSnapshot | null): StepItem[] {
  if (!snapshot) return []
  if (snapshot.plan?.subtasks.length) {
    return snapshot.plan.subtasks.map((task) => ({
      id: task.id,
      title: task.title,
      detail: task.description,
      status: task.status,
      result: task.result,
      toolCalls: task.toolCalls,
      agentConversationId: task.agentConversationId,
      assignedAgentName: task.assignedAgentName,
    }))
  }
  return (snapshot.progress?.steps || []).map((step) => ({
      id: step.id,
      title: step.description,
      detail: step.result,
      status: step.status,
      result: step.result,
      toolCalls: step.toolCalls,
      agentConversationId: step.agentConversationId,
      attempt: step.attempt,
      maxAttempts: step.maxAttempts,
      attempts: step.attempts,
  }))
}

function statusLabel(status?: TaskRunStatus) {
  if (!status) return 'Ready'
  return {
    queued: 'Queued',
    running: 'In progress',
    paused: 'Stopped',
    completed: 'Complete',
    failed: 'Needs attention',
    cancelled: 'Stopped',
    interrupted: 'Stopped',
  }[status]
}

function groupRequirementDocuments(documents: RequirementDocument[]): Array<[number, RequirementDocument[]]> {
  const byRound = new Map<number, RequirementDocument[]>()
  for (const document of documents) {
    const group = byRound.get(document.round) || []
    group.push(document)
    byRound.set(document.round, group)
  }
  return [...byRound.entries()].sort(([left], [right]) => left - right)
}

function processDocumentName(document: RequirementDocument): string {
  return document.title.replace(/^第\s*\d+\s*轮\s*/, '').trim() || document.title
}

function latestEvaluationStatus(run: RequirementRun): { blockers: string[]; checks: string[]; structured: boolean } {
  const evaluation = run.evaluations.at(-1)
  if (evaluation?.unresolvedItems) {
    const describe = (item: { id: string; fact: string; requiredDecision: string }) => `${item.id}: ${item.fact} (${item.requiredDecision})`
    return {
      blockers: evaluation.unresolvedItems.filter((item) => item.blocking).map(describe),
      checks: evaluation.unresolvedItems.filter((item) => !item.blocking).map(describe),
      structured: true,
    }
  }
  return { blockers: evaluation?.blockers || [], checks: [], structured: false }
}

export function TaskWorkspacePanel({ onCompactChange }: { onCompactChange?: (compact: boolean) => void } = {}) {
  const {
    language,
    currentFile,
    rightPanelTab,
    setCurrentFile,
    setRightPanelTab,
    workspacePath,
  } = useAppStore(useShallow(s => ({ language: s.language, currentFile: s.currentFile, rightPanelTab: s.rightPanelTab, setCurrentFile: s.setCurrentFile, setRightPanelTab: s.setRightPanelTab, workspacePath: s.workspacePath })))
  const copy = shellCopy[language]
  const t = (text: string) => workspaceText(language, text)
  const { conversations, currentConversationId, messages, selectConversation, setError, streamingByConversation } = useChatStore(useShallow(s => ({ conversations: s.conversations, currentConversationId: s.currentConversationId, messages: s.messages, selectConversation: s.selectConversation, setError: s.setError, streamingByConversation: s.streamingByConversation })))
  const { workspaces, activeWorkspaceId } = useWorkspaceStore(useShallow(s => ({ workspaces: s.workspaces, activeWorkspaceId: s.activeWorkspaceId })))
  const liveGoalTask = useTaskStore((state) => currentConversationId ? state.goalTasks[currentConversationId] || EMPTY_GOAL_TASK : EMPTY_GOAL_TASK)
  const liveExpertTask = useTaskStore((state) => currentConversationId ? state.expertTasks[currentConversationId] || EMPTY_EXPERT_TASK : EMPTY_EXPERT_TASK)
  const abortGoal = useTaskStore((state) => state.abortGoal)
  const abortExpertTask = useTaskStore((state) => state.abortExpertTask)
  const pauseGoal = useTaskStore((state) => state.pauseGoal)
  const resumeGoal = useTaskStore((state) => state.resumeGoal)
  const [snapshot, setSnapshot] = useState<TaskRunSnapshot | null>(null)
  const [activePlan, setActivePlan] = useState<ActivePlan | null>(null)
  const [artifacts, setArtifacts] = useState<TaskArtifactItem[]>([])
  const [requirementRuns, setRequirementRuns] = useState<RequirementRun[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const refreshGeneration = useRef(0)
  const [taskView, setTaskView] = useState<'plan' | 'usage'>('plan')
  const [showAllSteps, setShowAllSteps] = useState(false)
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null)
  const [showAllArtifacts, setShowAllArtifacts] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const currentConversation = conversations.find((conversation) => conversation.id === currentConversationId)
  const conversationInWorkspace = Boolean(currentConversation && (!activeWorkspaceId || currentConversation.workspaceId === activeWorkspaceId || (!currentConversation.workspaceId && currentConversation.workspacePath === activeWorkspace?.path)))
  const resolvedWorkspacePath = activeWorkspace?.path || workspacePath
  // The note ticks the round's plan. While a round streams, only its own updates
  // count: falling back to the previous reply would show finished ticks before
  // this round has published anything.
  const liveStream = currentConversationId ? streamingByConversation[currentConversationId] : undefined
  const latestResponse = [...messages].reverse().find(message => message.role === 'assistant' && !message.progressKind)
  const nativeTranscript = liveStream?.isStreaming ? liveStream.nativeAgent : latestResponse?.nativeAgent
  const nativeSummary = nativeTranscript ? { ...nativeTranscript, events: nativeTranscript.events.filter(event => ['session', 'goal', 'todo', 'retry', 'compaction_start', 'compaction_end'].includes(event.type)) } : undefined
  const roundChecklist = useMemo(() => nativeTranscript ? null : buildPlanChecklist(liveStream?.isStreaming
    ? liveStream.progressUpdates
    : latestResponse?.progressUpdates || []), [liveStream, latestResponse, nativeTranscript])
  const activePlanScopeKey = activeWorkspaceId
    ? `workspace:${activeWorkspaceId}`
    : resolvedWorkspacePath?.trim()
      ? `workspace-path:${resolvedWorkspacePath.trim().toLowerCase()}`
      : currentConversationId
        ? `conversation:${currentConversationId}`
        : ''
  const liveGoalProgress = liveGoalTask.progress?.conversationId === currentConversationId ? liveGoalTask.progress : null
  const steps = useMemo<StepItem[]>(() => {
    if (liveExpertTask.currentPlan?.subtasks.length) {
      return liveExpertTask.currentPlan.subtasks.map((task) => ({ id: task.id, title: task.title, detail: task.description, status: task.status, assignedAgentName: task.assignedAgentName }))
    }
    if (liveGoalProgress?.steps.length) {
      return liveGoalProgress.steps.map((step) => ({ id: step.id, title: step.description, detail: step.result, status: step.status, result: step.result, toolCalls: step.toolCalls, agentConversationId: step.agentConversationId, attempt: step.attempt, maxAttempts: step.maxAttempts, attempts: step.attempts }))
    }
    if (activePlan?.steps.length) return activePlan.steps.map((step) => ({ id: step.id, title: step.title, detail: step.detail, status: step.status, assignedAgentName: step.assignedAgentName }))
    return snapshotSteps(snapshot)
  }, [activePlan, liveExpertTask.currentPlan, liveGoalProgress, snapshot])
  const completedSteps = steps.filter((step) => step.status === 'completed').length
  const visibleSteps = showAllSteps ? steps : steps.slice(0, 5)
  const visibleArtifacts = showAllArtifacts ? artifacts : artifacts.slice(0, 3)
  const taskGoal = liveExpertTask.currentPlan?.goal || liveGoalProgress?.goal || snapshot?.goal || activePlan?.objective
  const taskWasCancelled = snapshot?.status === 'cancelled'
  const taskIsPaused = !taskWasCancelled && (liveGoalTask.isPaused || snapshot?.status === 'paused' || snapshot?.status === 'interrupted')
  const taskStatus = taskWasCancelled
    ? undefined
    : taskIsPaused
    ? (snapshot?.status === 'interrupted' ? 'interrupted' : 'paused')
    : liveExpertTask.isRunning || liveGoalTask.isRunning
      ? 'running'
      : snapshot?.status || liveExpertTask.recoveryStatus || liveGoalTask.recoveryStatus || (activePlan?.status === 'completed' ? 'completed' : activePlan?.status === 'failed' ? 'failed' : activePlan?.status === 'paused' ? 'paused' : activePlan?.status === 'active' ? 'running' : undefined)
  const hasTaskRun = !taskWasCancelled && Boolean(snapshot || activePlan || liveExpertTask.currentPlan || liveGoalProgress || liveExpertTask.isRunning || liveGoalTask.isRunning)
  const taskIsRunning = !taskIsPaused && (liveExpertTask.isRunning || liveGoalTask.isRunning || snapshot?.status === 'running' || snapshot?.status === 'queued')
  const taskCanResume = Boolean(snapshot && (taskIsPaused || taskStatus === 'failed'))
  const taskCanCancel = Boolean(snapshot && !taskWasCancelled && !['completed', 'cancelled'].includes(taskStatus || ''))
  const usageMessages = useMemo(() => messages.filter((message) => message.role === 'assistant' && message.usage), [messages])
  const usageTotals = useMemo(() => usageMessages.reduce((total, message) => ({
    prompt: total.prompt + (message.usage?.promptTokens || 0),
    completion: total.completion + (message.usage?.completionTokens || 0),
    cached: total.cached + (message.usage?.cachedTokens || 0),
    calls: total.calls + (message.usage?.modelCalls || 1),
  }), { prompt: 0, completion: 0, cached: 0, calls: 0 }), [usageMessages])
  const latestUsageMessage = usageMessages.at(-1)
  const contextBudget = getModelInputBudgetTokens(latestUsageMessage?.model || 'unknown')
  const contextTokens = latestUsageMessage?.usage?.promptTokens || 0
  const contextRate = contextBudget > 0 ? Math.min(100, (contextTokens / contextBudget) * 100) : 0
  const cacheRate = usageTotals.prompt > 0 ? (usageTotals.cached / usageTotals.prompt) * 100 : 0
  useEffect(() => {
    onCompactChange?.(rightPanelTab === 'tasks' && taskView === 'plan' && !nativeTranscript && !loading && !loadError && !hasTaskRun && !roundChecklist && artifacts.length === 0)
  }, [onCompactChange, rightPanelTab, taskView, loading, loadError, hasTaskRun, roundChecklist, nativeTranscript, artifacts.length])

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    if (!currentConversationId) {
      setLoading(false)
      setLoadError('')
      setSnapshot(null)
      setActivePlan(null)
      setArtifacts([])
      setRequirementRuns([])
      return
    }
    setLoading(true)
    setLoadError('')
    try {
      const [nextSnapshot, runs, nextRequirementRuns, nextActivePlan] = await Promise.all([
        window.eva.task.getSnapshot(currentConversationId),
        activeWorkspaceId ? window.eva.task.listArtifacts(activeWorkspaceId) : Promise.resolve([]),
        window.eva.requirements.listRuns(currentConversationId),
        activePlanScopeKey ? window.eva.activePlan.get(activePlanScopeKey) : Promise.resolve(null),
      ])
      if (generation !== refreshGeneration.current) return
      setSnapshot(nextSnapshot)
      setActivePlan(nextActivePlan)
      const run = runs.find((item) => item.conversationId === currentConversationId)
      setArtifacts(run?.files || [])
      setRequirementRuns(nextRequirementRuns)
    } catch (error) {
      if (generation !== refreshGeneration.current) return
      setLoadError(error instanceof Error ? error.message : String(error))
      console.error('Failed to load task workspace:', error)
      setSnapshot(null)
      setActivePlan(null)
      setArtifacts([])
      setRequirementRuns([])
    } finally {
      if (generation === refreshGeneration.current) setLoading(false)
    }
  }, [activePlanScopeKey, activeWorkspaceId, currentConversationId])

  useEffect(() => { void refresh(); return () => { refreshGeneration.current++ } }, [refresh])

  useEffect(() => {
    setShowAllArtifacts(false)
  }, [currentConversationId])

  useEffect(() => {
    if (rightPanelTab !== 'requirements') return
    void refresh()
  }, [messages.length, refresh, rightPanelTab])

  // Chat-triggered team runs persist their snapshot as task events arrive.
  // Refresh on the event itself so the panel can discover a run that started
  // after its initial load, before the active-run polling condition is known.
  useEffect(() => window.eva.task.onStream((_event, data) => {
    const teamEvent = data as unknown as TeamEvent & { conversationId?: string }
    if (teamEvent.conversationId === currentConversationId) void refresh()
  }), [currentConversationId, refresh])

  useEffect(() => window.eva.requirements.onProgress((_event, progress) => {
    if (progress.conversationId === currentConversationId) void refresh()
  }), [currentConversationId, refresh])

  useEffect(() => {
    setTaskView('plan')
    setShowAllSteps(false)
    setExpandedStepId(null)
  }, [currentConversationId])

  useEffect(() => {
    if ((!snapshot || !activeStatuses.includes(snapshot.status)) && !liveExpertTask.isRunning && !liveGoalTask.isRunning) return
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => window.clearInterval(timer)
  }, [liveExpertTask.isRunning, liveGoalTask.isRunning, refresh, snapshot])

  const openArtifact = async (artifact: TaskArtifactItem) => {
    if (!artifact.path || !resolvedWorkspacePath) return
    try {
      const content = await window.eva.file.read(artifact.path, resolvedWorkspacePath)
      const language = artifact.path.split('.').pop()?.toLowerCase() || ''
      setCurrentFile({ path: artifact.path, content, language })
      setRightPanelTab('editor')
    } catch (error) {
      console.error('Failed to open task artifact:', error)
    }
  }

  const openSelectedFile = () => setRightPanelTab('editor')

  const openRequirementDocument = (document: RequirementDocument) => {
    setCurrentFile({ path: document.workspacePath || document.path, content: document.content, language: 'markdown' })
    setRightPanelTab('editor')
  }

  const stopTask = async () => {
    if (!currentConversationId || stopping) return
    setStopping(true)
    try {
      if (snapshot?.kind === 'expert') {
        await window.eva.task.addFeedback(currentConversationId, 'Pause this task after the current operation.', undefined, true)
      } else if (liveGoalTask.isRunning || snapshot?.kind === 'goal') {
        await pauseGoal(currentConversationId)
      } else {
        await window.eva.task.addFeedback(currentConversationId, 'Pause this task after the current operation.', undefined, true)
      }
      await refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : t('Could not stop this task.'))
    } finally {
      setStopping(false)
    }
  }

  const continueTask = async () => {
    if (!currentConversationId || stopping || !snapshot) return
    setStopping(true)
    try {
      if (snapshot.status === 'paused') {
        if (snapshot.kind === 'goal') await resumeGoal(currentConversationId)
        else await window.eva.task.resumeFromCheckpoint(currentConversationId)
      } else {
        await window.eva.task.resume({ conversationId: snapshot.conversationId, kind: snapshot.kind, goal: snapshot.goal || snapshot.progress?.goal || snapshot.plan?.goal || '', agentId: snapshot.agentId || '' })
      }
      await refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : t('Could not continue this task.'))
    } finally {
      setStopping(false)
    }
  }

  const cancelTask = async () => {
    if (!currentConversationId || cancelling) return
    if (!window.confirm(t('Cancel this task? Its current execution cannot be continued.'))) return
    setCancelling(true)
    try {
      if (snapshot?.kind === 'goal') await abortGoal(currentConversationId)
      else await abortExpertTask(currentConversationId)
      await refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : t('Could not cancel this task.'))
    } finally {
      setCancelling(false)
    }
  }

  const openStepConversation = async (conversationId?: string) => {
    if (conversationId) await selectConversation(conversationId)
  }

  const openParentConversation = async () => {
    if (currentConversation?.parentConversationId) await selectConversation(currentConversation.parentConversationId)
  }

  return (
    <div className="task-workspace-panel flex min-h-0 flex-1 flex-col">
      <div className="task-workspace-note__tabs flex shrink-0 items-center gap-1 px-3 py-2" role="tablist" aria-label={t('Task workspace')} onKeyDown={(event) => {
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length
        tabs[next]?.focus()
        tabs[next]?.click()
        tabs[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }}>
        <button type="button" role="tab" tabIndex={rightPanelTab === 'purposes' ? 0 : -1} aria-selected={rightPanelTab === 'purposes'} onClick={() => setRightPanelTab('purposes')}
          className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'purposes' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}>
          <Target className="h-3.5 w-3.5" /> {language === 'zh' ? '主线' : language === 'ja' ? '主線' : 'Purposes'}
        </button>
        <button
          type="button"
          role="tab"
          tabIndex={rightPanelTab === 'tasks' ? 0 : -1}
          aria-selected={rightPanelTab === 'tasks'}
          onClick={() => { setRightPanelTab('tasks'); setTaskView('plan') }}
          className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'tasks' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}
        >
          <ListTodo className="h-3.5 w-3.5" /> {copy.tasks}
        </button>
        <button
          type="button"
          role="tab"
          tabIndex={rightPanelTab === 'files' ? 0 : -1}
          aria-selected={rightPanelTab === 'files'}
          onClick={() => setRightPanelTab('files')}
          className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'files' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}
        >
          <FolderOpen className="h-3.5 w-3.5" /> {copy.files}
        </button>
        <button
          type="button"
          role="tab"
          tabIndex={rightPanelTab === 'requirements' ? 0 : -1}
          aria-selected={rightPanelTab === 'requirements'}
          onClick={() => setRightPanelTab('requirements')}
          className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'requirements' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}
        >
          <ClipboardList className="h-3.5 w-3.5" /> {copy.requirements}
        </button>
        <button
          type="button"
          role="tab"
          tabIndex={rightPanelTab === 'project-knowledge' ? 0 : -1}
          aria-selected={rightPanelTab === 'project-knowledge'}
          onClick={() => setRightPanelTab('project-knowledge')}
          className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'project-knowledge' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}
        >
          <BookOpen className="h-3.5 w-3.5" /> {copy.records}
        </button>
        <button
          type="button"
          onClick={() => { setRightPanelTab('tasks'); setTaskView((view) => view === 'usage' ? 'plan' : 'usage') }}
          className={cn('ml-auto flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'tasks' && taskView === 'usage' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}
          title={taskView === 'usage' ? t('Show task plan') : t('Show conversation usage')}
          aria-label={taskView === 'usage' ? t('Show task plan') : t('Show conversation usage')}
        >
          <BarChart3 className="h-3.5 w-3.5" /> {copy.usage}
        </button>
        {currentFile && <button
          type="button"
          role="tab"
          tabIndex={rightPanelTab === 'editor' ? 0 : -1}
          aria-selected={rightPanelTab === 'editor'}
          onClick={openSelectedFile}
          className={cn('ml-auto flex max-w-[45%] items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'editor' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}
          title={currentFile.path}
        >
          <FileText className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{copy.document}</span>
        </button>}
      </div>

      {rightPanelTab === 'files' && <FileExplorer className="min-h-0 flex-1" onFileSelect={() => setRightPanelTab('editor')} />}
      {rightPanelTab === 'purposes' && <PurposePanel key={activeWorkspaceId} workspaceId={activeWorkspaceId} />}

      {rightPanelTab === 'project-knowledge' && <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3"><ProjectKnowledgePanel /></div>}

      {rightPanelTab === 'requirements' && conversationInWorkspace && (
        <div className="task-workspace-note__content min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="border-b border-indigo-100/80 pb-4">
            <h2 className="text-sm font-semibold text-zinc-800">需求工程文档</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-500">当前对话的分析、澄清与评测文档。点击文档在便签中打开。</p>
          </div>

          {requirementRuns.length === 0 ? (
            <div className="flex flex-col items-start py-8 text-sm leading-6 text-zinc-500">
              <ClipboardList className="mb-3 h-6 w-6 text-violet-300" />
              <p className="font-medium text-zinc-700">还没有需求工程文档</p>
              <p className="mt-1">在对话中输入 <code className="rounded bg-zinc-100 px-1 py-0.5 text-[11px] text-zinc-700">/requirement</code> 开始。</p>
            </div>
          ) : (
            <div className="divide-y divide-indigo-100/80">
              {requirementRuns.map((run) => <section key={run.id} className="py-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-zinc-800">需求工程记录</h3>
                  <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', run.status === 'ready-for-implementation' ? 'bg-emerald-50 text-emerald-700' : run.status === 'ready-for-specification' && run.specQualityScore === undefined ? 'bg-emerald-50 text-emerald-700' : run.status === 'failed' || run.status === 'cancelled' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700')}>{run.status === 'ready-for-implementation' || run.specQualityScore !== undefined ? `${run.specQualityScore || 0}/${run.specQualityThreshold || 85}` : `${run.qualityScore}/${run.qualityThreshold}`}</span>
                </div>
                 <p className="mt-1 text-xs text-zinc-500">{run.status === 'ready-for-implementation' ? `规格已校验通过（${run.specQualityScore || 0}/${run.specQualityThreshold || 85}），可进入实现阶段。` : run.status === 'specifying' ? '正在构建并校验规格文档。' : run.status === 'awaiting-spec-resolution' ? `规格校验未通过（${run.specQualityScore || 0}/${run.specQualityThreshold || 85}），请在对话中选择阻塞处置路径。` : run.status === 'ready-for-specification' ? (run.specQualityScore !== undefined ? `规格校验未通过（${run.specQualityScore}/${run.specQualityThreshold || 85}），请修订后再次执行 /spec。` : '需求已明确，可进入规格阶段。') : run.status === 'cancelled' ? '本轮已停止。' : run.status === 'failed' ? '本轮处理失败。' : '等待补充澄清后重新评测。'}</p>
                 {run.evaluations.length > 0 && (() => {
                   const status = latestEvaluationStatus(run)
                   return (
                     <div className="mt-2 rounded-md border border-zinc-100 bg-zinc-50/70 px-2.5 py-2 text-[11px] leading-5 text-zinc-600">
                       {status.blockers.length === 0 ? (
                         <span>{status.structured ? '结构化语义审计阻塞：无' : '本轮评测阻塞：无'}</span>
                       ) : (
                         <>
                           <span className="font-medium text-zinc-700">{status.structured ? '结构化语义审计发现' : '本轮评测提出'} {status.blockers.length} 项阻塞：</span>
                           <ul className="mt-1 list-disc space-y-0.5 pl-4">
                             {status.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                           </ul>
                         </>
                       )}
                       {status.checks.length > 0 && (
                         <p className="mt-1 text-zinc-500">后续规格核验 {status.checks.length} 项：{status.checks.join('；')}</p>
                       )}
                     </div>
                   )
                 })()}
                 {run.workspaceOutputPath && (
                   <p className="mt-2 truncate text-[11px] text-zinc-400" title={run.workspaceOutputPath}>
                     规格中间文档：{run.workspaceOutputPath}
                   </p>
                 )}
                 {run.dslOutputPath && (
                   <p className="mt-1 truncate text-[11px] text-zinc-400" title={run.dslOutputPath}>
                     DSL 输出目录：{run.dslOutputPath}
                   </p>
                 )}
                 {run.codingOutputPath && (
                   <p className="mt-1 truncate text-[11px] text-zinc-400" title={run.codingOutputPath}>
                     代码生成输出：{run.codingOutputPath}
                   </p>
                 )}
                 <div className="mt-4 space-y-4">
                  {groupRequirementDocuments(run.documents).map(([round, documents]) => <section key={round} aria-label={`第 ${round} 轮过程文档`}>
                    <h4 className="mb-1.5 text-xs font-semibold text-zinc-700">第 {round} 轮</h4>
                    <div className="space-y-1">
                       {documents.map((document) => <button key={document.id} type="button" onClick={() => openRequirementDocument(document)} onContextMenu={(event) => { event.preventDefault(); void window.eva.requirements.showDocumentContextMenu(document).catch((error) => console.error('Failed to open requirement document menu:', error)) }} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-zinc-600 transition-colors hover:bg-violet-50/70 hover:text-violet-800" title={document.workspacePath || document.path}>
                        <FileText className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                        <span className="min-w-0 flex-1 truncate">{processDocumentName(document)}</span>
                      </button>)}
                    </div>
                  </section>)}
                </div>
              </section>)}
            </div>
          )}
        </div>
      )}

      {rightPanelTab === 'editor' && currentFile && <CodeEditor className="min-h-0 flex-1" filePath={currentFile.path} content={currentFile.content} language={currentFile.language} />}

      {rightPanelTab === 'editor' && !currentFile && (
        <div className="flex flex-1 flex-col items-center justify-center px-7 text-center text-sm leading-6 text-zinc-500">
          <FileText className="mb-3 h-6 w-6 text-violet-300" />
          {t('Select a document from Files to preview it here.')}
        </div>
      )}

      {!conversationInWorkspace && (rightPanelTab === 'tasks' || rightPanelTab === 'requirements') && <div className="task-workspace-note__content min-h-0 flex-1 overflow-y-auto px-4 py-5 text-sm text-zinc-500">{language === 'zh' ? '请在左侧选择当前项目的会话，再查看执行记录、用量与需求文档。' : language === 'ja' ? '左側でこのプロジェクトの会話を選ぶと、実行記録、使用量、要件を確認できます。' : 'Select a conversation in this project to see its execution records, usage, and requirements.'}</div>}

      {rightPanelTab === 'tasks' && conversationInWorkspace && taskView === 'usage' && (
        <div className="task-workspace-note__content min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="border-b border-indigo-100/80 pb-4">
            <h2 className="text-sm font-semibold text-zinc-800">{t('Conversation usage')}</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{t('Token, cache, and context information for this conversation.')}</p>
          </div>

          {usageMessages.length === 0 ? (
            <div className="flex flex-col items-start py-8 text-sm leading-6 text-zinc-500">
              <BarChart3 className="mb-3 h-6 w-6 text-violet-300" />
              <p className="font-medium text-zinc-700">{t('No usage recorded yet')}</p>
              <p className="mt-1">{t('Usage appears after the first model response is complete.')}</p>
            </div>
          ) : (
            <div className="divide-y divide-indigo-100/80 text-sm">
              <section className="py-5">
                <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('Token volume')}</h3><span className="text-xs text-zinc-400">{usageTotals.calls} {language === 'zh' ? '次调用' : language === 'ja' ? '回の呼出し' : 'calls'}</span></div>
                <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3">
                  <div><dt className="text-xs text-zinc-500">{t('Total')}</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-zinc-800">{formatTokens(usageTotals.prompt + usageTotals.completion)}</dd></div>
                  <div><dt className="text-xs text-zinc-500">{t('Input')}</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-zinc-800">{formatTokens(usageTotals.prompt)}</dd></div>
                  <div><dt className="text-xs text-zinc-500">{t('Output')}</dt><dd className="mt-1 font-medium tabular-nums text-zinc-700">{formatTokens(usageTotals.completion)}</dd></div>
                  <div><dt className="text-xs text-zinc-500">{t('Latest model')}</dt><dd className="mt-1 truncate font-mono text-xs text-zinc-600" title={latestUsageMessage?.model}>{latestUsageMessage?.model || t('Unknown')}</dd></div>
                </dl>
              </section>

              <section className="py-5">
                <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('Prompt cache')}</h3><span className="text-sm font-semibold tabular-nums text-emerald-700">{cacheRate.toFixed(1)}%</span></div>
                <dl className="mt-3 grid grid-cols-2 gap-x-5">
                  <div><dt className="text-xs text-zinc-500">{t('Cached input')}</dt><dd className="mt-1 font-medium tabular-nums text-zinc-700">{formatTokens(usageTotals.cached)}</dd></div>
                  <div><dt className="text-xs text-zinc-500">{t('Uncached input')}</dt><dd className="mt-1 font-medium tabular-nums text-zinc-700">{formatTokens(Math.max(0, usageTotals.prompt - usageTotals.cached))}</dd></div>
                </dl>
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-emerald-400" style={{ width: `${cacheRate}%` }} /></div>
              </section>

              <section className="py-5">
                <div className="flex items-center justify-between gap-3"><h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('Current context')}</h3><span className="shrink-0 text-sm font-semibold tabular-nums text-violet-700">{contextRate.toFixed(1)}%</span></div>
                <p className="mt-2 text-xs leading-5 text-zinc-500">{language === 'zh' ? `最近请求使用 ${formatTokens(contextTokens)} / ${formatTokens(contextBudget)} 输入 Token。` : language === 'ja' ? `直近のリクエスト: ${formatTokens(contextTokens)} / ${formatTokens(contextBudget)} 入力トークン。` : `Latest request: ${formatTokens(contextTokens)} of ${formatTokens(contextBudget)} available input tokens.`}</p>
                {latestUsageMessage?.usage?.contextDiagnostics && (
                  <p className="mt-1 text-xs leading-5 text-zinc-500">
                    Local estimate: {formatTokens(latestUsageMessage.usage.contextDiagnostics.estimatedTokens)}; retained {latestUsageMessage.usage.contextDiagnostics.retainedMessages}, omitted {latestUsageMessage.usage.contextDiagnostics.omittedMessages}, compacted {latestUsageMessage.usage.contextDiagnostics.compactedMessages}.
                  </p>
                )}
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.max(contextRate, contextTokens > 0 ? 0.7 : 0)}%` }} /></div>
              </section>
            </div>
          )}
        </div>
      )}

      {rightPanelTab === 'tasks' && conversationInWorkspace && taskView === 'plan' && (
        <div className="task-workspace-note__content min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {loadError && <div role="alert" className="purpose-error"><p>{language === 'zh' ? '无法读取执行记录，请重试。' : language === 'ja' ? '実行記録を読み込めません。再試行してください。' : 'Could not load execution records. Please retry.'}</p><details><summary>{language === 'zh' ? '错误详情' : 'Details'}</summary>{loadError}</details><button type="button" onClick={() => void refresh()}>{copy.retry}</button></div>}
          <div className="flex items-start justify-between gap-3 border-b border-indigo-100/80 pb-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-800">{t('Task workspace')}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {nativeTranscript && taskStatus && <span className="text-[11px] text-zinc-400">Eva 扩展</span>}
              {taskStatus && <span className={cn('eva-status', taskStatus === 'completed' ? 'eva-status--success' : taskStatus === 'failed' ? 'eva-status--error' : taskStatus ? 'eva-status--active' : 'eva-status--neutral')}>
                {t(statusLabel(taskStatus))}
              </span>}
              {(taskIsRunning || taskCanResume || taskCanCancel) && <>
                {(taskIsRunning || taskCanResume) && <button type="button" onClick={() => void (taskCanResume ? continueTask() : stopTask())} disabled={stopping} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-violet-700 transition-colors hover:bg-violet-50 disabled:cursor-wait disabled:opacity-60" title={taskCanResume ? t('Continue this task') : t('Stop after the current operation')}>
                  {taskCanResume ? <Play className="h-3 w-3 fill-current" /> : <Square className="h-3 w-3 fill-current" />}{stopping ? t('Working...') : taskCanResume ? t('Continue') : t('Stop')}
                </button>}
                {taskCanCancel && <button type="button" onClick={() => void cancelTask()} disabled={cancelling} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-wait disabled:opacity-60" title={t('Cancel this task')}>
                  <CircleMinus className="h-3.5 w-3.5" />{cancelling ? t('Cancelling...') : t('Cancel')}
                </button>}
              </>}
            </div>
          </div>

          {roundChecklist && (
            <section className="border-b border-indigo-100/80 py-4">
              <PlanChecklist checklist={roundChecklist} streaming={Boolean(liveStream?.isStreaming)} />
            </section>
          )}

          {nativeSummary && <section className="border-b border-indigo-100/80 py-4">
            <NativeAgentView transcript={nativeSummary} finalContent="" streaming={Boolean(liveStream?.isStreaming)} renderMarkdown={content => <p>{content}</p>} />
          </section>}
          {nativeSummary && hasTaskRun && <p className="mt-3 text-xs text-zinc-400">Eva 扩展任务记录</p>}

          {!hasTaskRun ? nativeTranscript ? null : (
            loading ? <p className="py-6 text-sm text-zinc-500">{language === 'zh' ? '正在读取执行记录…' : language === 'ja' ? '実行記録を読み込み中…' : 'Loading execution records…'}</p> : loadError ? null : currentConversation?.parentConversationId ? (
              <div className="border-b border-indigo-100/80 py-4">
                <div className="flex items-start gap-2 rounded-md bg-violet-50/70 px-3 py-3 text-xs leading-5 text-zinc-600">
                  <Target className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-zinc-800">{t('Hidden Goal step conversation')}</p>
                    <p className="mt-1">{t('This conversation is scoped to one Goal step and is hidden from the left conversation list.')}</p>
                    <button type="button" onClick={() => void openParentConversation()} className="mt-2 inline-flex items-center gap-1 font-medium text-violet-700 hover:text-violet-900">
                      <ChevronRight className="h-3.5 w-3.5 rotate-180" /> {t('Back to parent task')}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-start py-5 text-sm leading-6 text-zinc-500">
                <PanelTopOpen className="mb-3 h-6 w-6 text-violet-300" />
                <p className="font-medium text-zinc-700">{t('No task plan yet')}</p><p className="mt-1 text-xs leading-5">{language === 'zh' ? '直接在对话中说明任务；长期目标可以先建立项目主线。' : language === 'ja' ? '会話で作業を依頼できます。長期の目標には主線を作成します。' : 'Describe a task in chat, or create a project purpose for a longer goal.'}</p><button type="button" className="mt-3 text-xs font-medium text-[var(--accent)]" onClick={() => useAppStore.getState().openPurposeWorkspace()}>{copy.purposes}</button>
              </div>
            )
          ) : (
            <>
              {taskGoal && <p className="mt-4 line-clamp-2 border-l-2 border-violet-200 pl-3 text-xs leading-5 text-zinc-600">{taskGoal}</p>}
              <section className="mt-5">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('Task outline')}</h2>
                  <span className="text-xs tabular-nums text-zinc-400">{completedSteps}/{steps.length}</span>
                </div>
                {steps.length === 0 ? (
                  <p className="py-2 text-sm text-zinc-500">{t('Eva is preparing the task plan.')}</p>
                ) : (
                  <ol className="space-y-1">
                    {visibleSteps.map((step, index) => {
                      const isExpanded = expandedStepId === step.id
                      const hasActivity = Boolean(step.toolCalls?.length || step.detail || step.result || step.attempts?.length)
                      return (
                        <li key={step.id} className="rounded-md">
                          <div role="button" tabIndex={0} onClick={() => setExpandedStepId((current) => current === step.id ? null : step.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setExpandedStepId((current) => current === step.id ? null : step.id) }} aria-expanded={isExpanded} className="flex w-full items-start gap-2.5 rounded-md px-1 py-2 text-left transition-colors hover:bg-violet-50/70">
                            <StepStatusIcon status={step.status} paused={taskIsPaused} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start gap-2">
                                <span className="mt-0.5 text-xs tabular-nums text-zinc-400">{index + 1}</span>
                                <p className={cn('min-w-0 flex-1 truncate text-sm leading-5', step.status === 'completed' ? 'text-zinc-500' : 'font-medium text-zinc-700')} title={step.title}>{step.title}</p>
                                {step.assignedAgentName && <span className="max-w-28 shrink-0 truncate rounded bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-700" title={`${language === 'zh' ? '执行智能体：' : language === 'ja' ? '担当: ' : 'Assigned to '}${step.assignedAgentName}`}>{step.assignedAgentName}</span>}
                                {step.maxAttempts && step.maxAttempts > 1 && <span className={cn('mt-0.5 shrink-0 text-[11px] tabular-nums', step.status === 'in_progress' ? 'text-violet-600' : step.status === 'failed' ? 'text-rose-600' : 'text-zinc-400')}>尝试 {step.attempt || 1}/{step.maxAttempts}</span>}
                                {step.agentConversationId && <button type="button" onClick={(event) => { event.stopPropagation(); void openStepConversation(step.agentConversationId) }} className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-violet-500 hover:bg-violet-100 hover:text-violet-800" title={t('Open this step conversation')} aria-label={t('Open this step conversation')}><ExternalLink className="h-3.5 w-3.5" /></button>}
                                {isExpanded ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />}
                              </div>
                            </div>
                          </div>
                          {isExpanded && (
                            <div className="mb-2 ml-7 border-l-2 border-violet-100 pl-3 pr-1 text-xs leading-5 text-zinc-600">
                              <div className="flex items-center justify-between gap-3"><span className="font-medium text-zinc-700">{t(stepStatusLabel(step.status))}</span>{step.toolCalls?.length ? <span className="shrink-0 text-zinc-400">{step.toolCalls.length} {language === 'zh' ? '条执行记录' : language === 'ja' ? '件の実行記録' : 'activities'}</span> : null}</div>
                              {step.attempts?.length ? <div className="mt-2 space-y-1 rounded bg-violet-50/50 px-2.5 py-2"><p className="text-[11px] font-medium uppercase tracking-wide text-violet-500">{t('Retry history')}</p>{step.attempts.map((attempt) => <p key={attempt.attempt} className={cn('text-xs', attempt.status === 'failed' ? 'text-rose-600' : attempt.status === 'completed' ? 'text-emerald-700' : 'text-violet-700')}>{language === 'zh' ? '尝试' : language === 'ja' ? '試行' : 'Attempt'} {attempt.attempt}: {attempt.status === 'failed' ? attempt.error || t('Connection failed') : attempt.status === 'completed' ? t('Completed') : t('Retry in progress')}</p>)}</div> : null}
                              {step.detail && <p className="mt-1.5 whitespace-pre-wrap break-words">{step.detail}</p>}
                              {step.result && step.result !== step.detail && <div className="mt-2 rounded bg-zinc-50 px-2.5 py-2 text-zinc-600"><p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-400">{t('Result')}</p><p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{step.result}</p></div>}
                              {step.status === 'failed' && !step.agentConversationId && !step.toolCalls?.length && <p className="mt-2 rounded bg-amber-50 px-2.5 py-2 text-amber-800">未启动：前置任务未完成，因此没有创建子对话或执行记录。</p>}
                              {step.toolCalls?.length ? <div className="mt-2 space-y-1.5"><p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{t('Execution activity')}</p>{step.toolCalls.map((toolCall) => <div key={toolCall.id} className="rounded bg-zinc-50 px-2.5 py-2"><div className="flex items-center justify-between gap-3"><span className="truncate font-medium text-zinc-700">{toolCall.name}</span><span className={cn('shrink-0 text-[11px]', toolCall.isError ? 'text-rose-500' : toolCall.result ? 'text-emerald-600' : 'text-violet-500')}>{toolCall.isError ? t('Failed') : toolCall.result ? t('Completed') : t('In progress')}</span></div>{toolCall.result && <p className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-zinc-500">{toolCall.result}</p>}</div>)}</div> : !hasActivity && <p className="mt-1.5 text-zinc-400">{t('Execution records will appear here as this step progresses.')}</p>}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ol>
                )}
                {steps.length > 5 && <button type="button" onClick={() => setShowAllSteps((show) => !show)} className="mt-2 text-xs font-medium text-violet-700 hover:text-violet-900">{showAllSteps ? t('Show less') : language === 'zh' ? `显示全部 ${steps.length} 个步骤` : language === 'ja' ? `全 ${steps.length} ステップを表示` : `Show all ${steps.length} steps`}</button>}
              </section>
            </>
          )}

          {(hasTaskRun || artifacts.length > 0) && <section className="mt-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('Generated documents')}</h2>
              <button type="button" onClick={() => setRightPanelTab('files')} className="text-xs font-medium text-violet-700 hover:text-violet-900">{t('Browse files')}</button>
            </div>
            {artifacts.length === 0 && <p className="text-xs text-zinc-500">{t('No generated documents yet.')}</p>}
            {artifacts.length > 0 && (
              <div className="space-y-1">
                {visibleArtifacts.map((artifact) => <button key={artifact.id} type="button" onClick={() => void openArtifact(artifact)} onContextMenu={(event) => { event.preventDefault(); if (!artifact.path) return; void window.eva.file.showContextMenu({ path: artifact.path, ...(resolvedWorkspacePath ? { workspacePath: resolvedWorkspacePath } : {}), isDirectory: false }).catch((error) => console.error('Failed to open task artifact menu:', error)) }} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-zinc-600 transition-colors hover:bg-violet-50/70 hover:text-violet-800" title={artifact.path}>
                  <FileText className="h-4 w-4 shrink-0 text-violet-400" />
                  <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
                </button>)}
                {artifacts.length > 3 && <button type="button" onClick={() => setShowAllArtifacts((show) => !show)} className="mt-1 px-2 text-xs font-medium text-violet-700 hover:text-violet-900">{showAllArtifacts ? '收起到 3 个文件' : `显示全部 ${artifacts.length} 个文件`}</button>}
              </div>
            )}
          </section>}
        </div>
      )}
    </div>
  )
}
