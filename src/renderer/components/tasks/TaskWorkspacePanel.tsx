import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  CheckCircle2,
  ClipboardList,
  Circle,
  CircleX,
  FileText,
  FolderOpen,
  ListTodo,
  Loader2,
  PanelTopOpen,
  Play,
  Square,
  X,
} from 'lucide-react'
import type { TaskArtifactItem, TaskRunSnapshot, TaskRunStatus, TaskStatus } from '../../../shared/types/task'
import { getModelInputBudgetTokens } from '../../../shared/constants'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { FileExplorer } from '@/components/editor/FileExplorer'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { EMPTY_EXPERT_TASK, EMPTY_GOAL_TASK, useTaskStore } from '@/stores/use-task-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import type { RequirementDocument, RequirementRun } from '../../../shared/types/requirement-engineering'

type StepItem = {
  id: string
  title: string
  detail?: string
  status: TaskStatus
}

const activeStatuses: TaskRunStatus[] = ['queued', 'running', 'paused']

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

function StepStatusIcon({ status, paused = false }: { status: TaskStatus | TaskRunStatus; paused?: boolean }) {
  if (status === 'completed') return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
  if (paused && (status === 'in_progress' || status === 'running')) return <Square className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-400" />
  if (status === 'in_progress' || status === 'running') return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-violet-500" />
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-300" />
}

function snapshotSteps(snapshot: TaskRunSnapshot | null): StepItem[] {
  if (!snapshot) return []
  if (snapshot.plan?.subtasks.length) {
    return snapshot.plan.subtasks.map((task) => ({
      id: task.id,
      title: task.title,
      detail: task.description,
      status: task.status,
    }))
  }
  return (snapshot.progress?.steps || []).map((step) => ({
    id: step.id,
    title: step.description,
    detail: step.result,
    status: step.status,
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

export function TaskWorkspacePanel() {
  const {
    currentFile,
    rightPanelTab,
    setCurrentFile,
    setRightPanelTab,
    workspacePath,
  } = useAppStore()
  const { currentConversationId, messages } = useChatStore()
  const { workspaces, activeWorkspaceId } = useWorkspaceStore()
  const liveGoalTask = useTaskStore((state) => currentConversationId ? state.goalTasks[currentConversationId] || EMPTY_GOAL_TASK : EMPTY_GOAL_TASK)
  const liveExpertTask = useTaskStore((state) => currentConversationId ? state.expertTasks[currentConversationId] || EMPTY_EXPERT_TASK : EMPTY_EXPERT_TASK)
  const abortGoal = useTaskStore((state) => state.abortGoal)
  const abortExpertTask = useTaskStore((state) => state.abortExpertTask)
  const pauseGoal = useTaskStore((state) => state.pauseGoal)
  const resumeGoal = useTaskStore((state) => state.resumeGoal)
  const [snapshot, setSnapshot] = useState<TaskRunSnapshot | null>(null)
  const [artifacts, setArtifacts] = useState<TaskArtifactItem[]>([])
  const [requirementRuns, setRequirementRuns] = useState<RequirementRun[]>([])
  const [loading, setLoading] = useState(false)
  const [taskView, setTaskView] = useState<'plan' | 'usage'>('plan')
  const [showAllSteps, setShowAllSteps] = useState(false)
  const [showAllArtifacts, setShowAllArtifacts] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const resolvedWorkspacePath = activeWorkspace?.path || workspacePath
  const liveGoalProgress = liveGoalTask.progress?.conversationId === currentConversationId ? liveGoalTask.progress : null
  const steps = useMemo(() => {
    if (liveExpertTask.currentPlan?.subtasks.length) {
      return liveExpertTask.currentPlan.subtasks.map((task) => ({ id: task.id, title: task.title, detail: task.description, status: task.status }))
    }
    if (liveGoalProgress?.steps.length) {
      return liveGoalProgress.steps.map((step) => ({ id: step.id, title: step.description, detail: step.result, status: step.status }))
    }
    return snapshotSteps(snapshot)
  }, [liveExpertTask.currentPlan, liveGoalProgress, snapshot])
  const completedSteps = steps.filter((step) => step.status === 'completed').length
  const visibleSteps = showAllSteps ? steps : steps.slice(0, 5)
  const visibleArtifacts = showAllArtifacts ? artifacts : artifacts.slice(0, 3)
  const taskGoal = liveExpertTask.currentPlan?.goal || liveGoalProgress?.goal || snapshot?.goal
  const taskIsPaused = liveGoalTask.isPaused || snapshot?.status === 'paused' || snapshot?.status === 'interrupted'
  const taskStatus = taskIsPaused
    ? (snapshot?.status === 'interrupted' ? 'interrupted' : 'paused')
    : liveExpertTask.isRunning || liveGoalTask.isRunning
      ? 'running'
      : snapshot?.status || liveExpertTask.recoveryStatus || liveGoalTask.recoveryStatus
  const hasTaskRun = Boolean(snapshot || liveExpertTask.currentPlan || liveGoalProgress || liveExpertTask.isRunning || liveGoalTask.isRunning)
  const taskIsRunning = !taskIsPaused && (liveExpertTask.isRunning || liveGoalTask.isRunning || snapshot?.status === 'running' || snapshot?.status === 'queued')
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

  const refresh = useCallback(async () => {
    if (!currentConversationId) {
      setSnapshot(null)
      setArtifacts([])
      setRequirementRuns([])
      return
    }
    setLoading(true)
    try {
      const [nextSnapshot, runs, nextRequirementRuns] = await Promise.all([
        window.eva.task.getSnapshot(currentConversationId),
        activeWorkspaceId ? window.eva.task.listArtifacts(activeWorkspaceId) : Promise.resolve([]),
        window.eva.requirements.listRuns(currentConversationId),
      ])
      setSnapshot(nextSnapshot)
      const run = runs.find((item) => item.conversationId === currentConversationId)
      setArtifacts(run?.files || [])
      setRequirementRuns(nextRequirementRuns)
    } catch (error) {
      console.error('Failed to load task workspace:', error)
      setSnapshot(null)
      setArtifacts([])
      setRequirementRuns([])
    } finally {
      setLoading(false)
    }
  }, [activeWorkspaceId, currentConversationId])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    setShowAllArtifacts(false)
  }, [currentConversationId])

  useEffect(() => {
    if (rightPanelTab !== 'requirements') return
    void refresh()
  }, [messages.length, refresh, rightPanelTab])

  useEffect(() => window.eva.requirements.onProgress((_event, progress) => {
    if (progress.conversationId === currentConversationId) void refresh()
  }), [currentConversationId, refresh])

  useEffect(() => {
    setTaskView('plan')
    setShowAllSteps(false)
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
        pauseGoal(currentConversationId)
      } else {
        await window.eva.task.addFeedback(currentConversationId, 'Pause this task after the current operation.', undefined, true)
      }
      await refresh()
    } finally {
      setStopping(false)
    }
  }

  const continueTask = async () => {
    if (!currentConversationId || stopping || !snapshot) return
    setStopping(true)
    try {
      if (snapshot.status === 'paused') {
        if (snapshot.kind === 'goal') resumeGoal(currentConversationId)
        else await window.eva.task.resumeFromCheckpoint(currentConversationId)
      } else {
        await window.eva.task.resume({ conversationId: snapshot.conversationId, kind: snapshot.kind, goal: snapshot.goal || snapshot.progress?.goal || snapshot.plan?.goal || '', agentId: snapshot.agentId || '' })
      }
      await refresh()
    } finally {
      setStopping(false)
    }
  }

  const cancelTask = async () => {
    if (!currentConversationId || cancelling) return
    if (!window.confirm('Cancel this task? Its current execution cannot be continued.')) return
    setCancelling(true)
    try {
      if (snapshot?.kind === 'goal') await abortGoal(currentConversationId)
      else await abortExpertTask(currentConversationId)
      await refresh()
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="task-workspace-panel flex min-h-0 flex-1 flex-col">
      <div className="task-workspace-note__tabs flex shrink-0 items-center gap-1 px-3 py-2" role="tablist" aria-label="Task workspace">
        <button
          type="button"
          role="tab"
          aria-selected={rightPanelTab === 'tasks'}
          onClick={() => { setRightPanelTab('tasks'); setTaskView('plan') }}
          className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'tasks' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}
        >
          <ListTodo className="h-3.5 w-3.5" /> Tasks
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={rightPanelTab === 'files'}
          onClick={() => setRightPanelTab('files')}
          className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'files' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}
        >
          <FolderOpen className="h-3.5 w-3.5" /> Files
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={rightPanelTab === 'requirements'}
          onClick={() => setRightPanelTab('requirements')}
          className={cn('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'requirements' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}
        >
          <ClipboardList className="h-3.5 w-3.5" /> 需求
        </button>
        <button
          type="button"
          onClick={() => { setRightPanelTab('tasks'); setTaskView((view) => view === 'usage' ? 'plan' : 'usage') }}
          className={cn('ml-auto flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'tasks' && taskView === 'usage' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}
          title={taskView === 'usage' ? 'Show task plan' : 'Show conversation usage'}
          aria-label={taskView === 'usage' ? 'Show task plan' : 'Show conversation usage'}
        >
          <BarChart3 className="h-3.5 w-3.5" /> Usage
        </button>
        {currentFile && <button
          type="button"
          role="tab"
          aria-selected={rightPanelTab === 'editor'}
          onClick={openSelectedFile}
          className={cn('ml-auto flex max-w-[45%] items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors', rightPanelTab === 'editor' ? 'bg-violet-100/80 text-violet-800' : 'text-zinc-500 hover:bg-white/75 hover:text-zinc-800')}
          title={currentFile.path}
        >
          <FileText className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">Document</span>
        </button>}
      </div>

      {rightPanelTab === 'files' && <FileExplorer className="min-h-0 flex-1" onFileSelect={() => setRightPanelTab('editor')} />}

      {rightPanelTab === 'requirements' && (
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
          Select a document from Files to preview it here.
        </div>
      )}

      {rightPanelTab === 'tasks' && taskView === 'usage' && (
        <div className="task-workspace-note__content min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="border-b border-indigo-100/80 pb-4">
            <h2 className="text-sm font-semibold text-zinc-800">Conversation usage</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-500">Token, cache, and context information for this conversation.</p>
          </div>

          {usageMessages.length === 0 ? (
            <div className="flex flex-col items-start py-8 text-sm leading-6 text-zinc-500">
              <BarChart3 className="mb-3 h-6 w-6 text-violet-300" />
              <p className="font-medium text-zinc-700">No usage recorded yet</p>
              <p className="mt-1">Usage appears after the first model response is complete.</p>
            </div>
          ) : (
            <div className="divide-y divide-indigo-100/80 text-sm">
              <section className="py-5">
                <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Token volume</h3><span className="text-xs text-zinc-400">{usageTotals.calls} calls</span></div>
                <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3">
                  <div><dt className="text-xs text-zinc-500">Total</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-zinc-800">{formatTokens(usageTotals.prompt + usageTotals.completion)}</dd></div>
                  <div><dt className="text-xs text-zinc-500">Input</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-zinc-800">{formatTokens(usageTotals.prompt)}</dd></div>
                  <div><dt className="text-xs text-zinc-500">Output</dt><dd className="mt-1 font-medium tabular-nums text-zinc-700">{formatTokens(usageTotals.completion)}</dd></div>
                  <div><dt className="text-xs text-zinc-500">Latest model</dt><dd className="mt-1 truncate font-mono text-xs text-zinc-600" title={latestUsageMessage?.model}>{latestUsageMessage?.model || 'Unknown'}</dd></div>
                </dl>
              </section>

              <section className="py-5">
                <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Prompt cache</h3><span className="text-sm font-semibold tabular-nums text-emerald-700">{cacheRate.toFixed(1)}%</span></div>
                <dl className="mt-3 grid grid-cols-2 gap-x-5">
                  <div><dt className="text-xs text-zinc-500">Cached input</dt><dd className="mt-1 font-medium tabular-nums text-zinc-700">{formatTokens(usageTotals.cached)}</dd></div>
                  <div><dt className="text-xs text-zinc-500">Uncached input</dt><dd className="mt-1 font-medium tabular-nums text-zinc-700">{formatTokens(Math.max(0, usageTotals.prompt - usageTotals.cached))}</dd></div>
                </dl>
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-emerald-400" style={{ width: `${cacheRate}%` }} /></div>
              </section>

              <section className="py-5">
                <div className="flex items-center justify-between gap-3"><h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Current context</h3><span className="shrink-0 text-sm font-semibold tabular-nums text-violet-700">{contextRate.toFixed(1)}%</span></div>
                <p className="mt-2 text-xs leading-5 text-zinc-500">Latest request: {formatTokens(contextTokens)} of {formatTokens(contextBudget)} available input tokens.</p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.max(contextRate, contextTokens > 0 ? 0.7 : 0)}%` }} /></div>
              </section>
            </div>
          )}
        </div>
      )}

      {rightPanelTab === 'tasks' && taskView === 'plan' && (
        <div className="task-workspace-note__content min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="flex items-start justify-between gap-3 border-b border-indigo-100/80 pb-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-800">Task workspace</span>
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={cn('eva-status', taskStatus === 'completed' ? 'eva-status--success' : taskStatus === 'failed' ? 'eva-status--error' : taskStatus ? 'eva-status--active' : 'eva-status--neutral')}>
                {statusLabel(taskStatus)}
              </span>
              {(taskIsRunning || taskIsPaused) && <>
                <button type="button" onClick={() => void (taskIsPaused ? continueTask() : stopTask())} disabled={stopping} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-violet-700 transition-colors hover:bg-violet-50 disabled:cursor-wait disabled:opacity-60" title={taskIsPaused ? 'Continue this task' : 'Stop after the current operation'}>
                  {taskIsPaused ? <Play className="h-3 w-3 fill-current" /> : <Square className="h-3 w-3 fill-current" />}{stopping ? 'Working...' : taskIsPaused ? 'Continue' : 'Stop'}
                </button>
                <button type="button" onClick={() => void cancelTask()} disabled={cancelling} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-wait disabled:opacity-60" title="Cancel this task">
                  <X className="h-3 w-3" />{cancelling ? 'Cancelling...' : 'Cancel'}
                </button>
              </>}
            </div>
          </div>

          {!hasTaskRun ? (
            <div className="flex flex-col items-start py-8 text-sm leading-6 text-zinc-500">
              <PanelTopOpen className="mb-3 h-6 w-6 text-violet-300" />
              <p className="font-medium text-zinc-700">No task plan yet</p>
            </div>
          ) : (
            <>
              {taskGoal && <p className="mt-4 line-clamp-2 border-l-2 border-violet-200 pl-3 text-xs leading-5 text-zinc-600">{taskGoal}</p>}
              <section className="mt-5">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Task outline</h2>
                  <span className="text-xs tabular-nums text-zinc-400">{completedSteps}/{steps.length}</span>
                </div>
                {steps.length === 0 ? (
                  <p className="py-2 text-sm text-zinc-500">Eva is preparing the task plan.</p>
                ) : (
                  <ol className="space-y-1">
                    {visibleSteps.map((step, index) => (
                      <li key={step.id} className="flex gap-2.5 rounded-md px-1 py-2">
                        <StepStatusIcon status={step.status} paused={taskIsPaused} />
                        <div className="min-w-0 flex-1">
                          <div className="flex gap-2"><span className="text-xs tabular-nums text-zinc-400">{index + 1}</span><p className={cn('truncate text-sm leading-5', step.status === 'completed' ? 'text-zinc-500' : 'font-medium text-zinc-700')} title={step.title}>{step.title}</p></div>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                {steps.length > 5 && <button type="button" onClick={() => setShowAllSteps((show) => !show)} className="mt-2 text-xs font-medium text-violet-700 hover:text-violet-900">{showAllSteps ? 'Show less' : `Show all ${steps.length} steps`}</button>}
              </section>
            </>
          )}

          <section className="mt-6 border-t border-indigo-100/80 pt-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Generated documents</h2>
              <button type="button" onClick={() => setRightPanelTab('files')} className="text-xs font-medium text-violet-700 hover:text-violet-900">Browse files</button>
            </div>
            {artifacts.length > 0 && (
              <div className="space-y-1">
                {visibleArtifacts.map((artifact) => <button key={artifact.id} type="button" onClick={() => void openArtifact(artifact)} onContextMenu={(event) => { event.preventDefault(); if (!artifact.path) return; void window.eva.file.showContextMenu({ path: artifact.path, ...(resolvedWorkspacePath ? { workspacePath: resolvedWorkspacePath } : {}), isDirectory: false }).catch((error) => console.error('Failed to open task artifact menu:', error)) }} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-zinc-600 transition-colors hover:bg-violet-50/70 hover:text-violet-800" title={artifact.path}>
                  <FileText className="h-4 w-4 shrink-0 text-violet-400" />
                  <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
                </button>)}
                {artifacts.length > 3 && <button type="button" onClick={() => setShowAllArtifacts((show) => !show)} className="mt-1 px-2 text-xs font-medium text-violet-700 hover:text-violet-900">{showAllArtifacts ? '收起到 3 个文件' : `显示全部 ${artifacts.length} 个文件`}</button>}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
