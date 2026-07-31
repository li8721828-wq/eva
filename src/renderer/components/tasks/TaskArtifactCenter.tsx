import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Circle,
  MessageSquarePlus,
  FileOutput,
  FileText,
  FolderKanban,
  Globe2,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Search,
  StopCircle,
  TerminalSquare,
  XCircle,
} from 'lucide-react'
import type { TaskArtifactItem, TaskArtifactRun, TaskStatus } from '../../../shared/types/task'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { MarkdownMessageContent } from '@/components/chat/MessageBubble'

const statusMeta: Record<TaskStatus | TaskArtifactRun['status'], { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'text-zinc-500' },
  queued: { label: 'Queued', className: 'text-amber-700' },
  in_progress: { label: 'Running', className: 'text-violet-700' },
  completed: { label: 'Complete', className: 'text-emerald-700' },
  failed: { label: 'Needs attention', className: 'text-red-700' },
  cancelled: { label: 'Cancelled', className: 'text-zinc-600' },
  running: { label: 'Running', className: 'text-violet-700' },
  paused: { label: 'Paused', className: 'text-amber-700' },
  interrupted: { label: 'Interrupted', className: 'text-amber-700' },
}

function StatusIcon({ status }: { status: TaskStatus | TaskArtifactRun['status'] }) {
  if (status === 'completed') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />
  if (status === 'failed') return <XCircle className="h-4 w-4 text-red-500" />
  if (status === 'running' || status === 'in_progress') return <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
  if (status === 'queued') return <Circle className="h-4 w-4 text-amber-500" />
  return <Circle className="h-4 w-4 text-zinc-400" />
}

function ArtifactRow({ item, icon: Icon }: { item: TaskArtifactItem; icon: typeof Search }) {
  const result = item.result?.trim()
  return (
    <details className="group border-b border-zinc-100 last:border-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-1 py-3 text-sm marker:hidden hover:text-zinc-950">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform group-open:rotate-90" />
        <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
        <span className="min-w-0 flex-1 truncate font-medium text-zinc-700">{item.title}</span>
        {(item.count || 1) > 1 && <span className="text-xs tabular-nums text-zinc-400">x{item.count}</span>}
        {item.isError ? <XCircle className="h-4 w-4 text-red-500" /> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
      </summary>
      <div className="pb-4 pl-11 pr-5 text-sm leading-6 text-zinc-500">
        {item.detail && <p>{item.detail}</p>}
        {item.path && <p className="mt-1 break-all font-mono text-xs text-zinc-500">{item.path}</p>}
        {item.url && <a className="mt-1 block break-all text-violet-700 hover:text-violet-900" href={item.url} target="_blank" rel="noreferrer">{item.url}</a>}
        {result && <p className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-600">{result}</p>}
      </div>
    </details>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="py-7 first:pt-0">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</h2>
        <span className="text-xs text-zinc-400">{count}</span>
      </div>
      {children}
    </section>
  )
}

export function TaskArtifactCenter() {
  const { artifactWorkspaceId, closeTaskArtifacts } = useAppStore()
  const { workspaces } = useWorkspaceStore()
  const { selectConversation } = useChatStore()
  const [runs, setRuns] = useState<TaskArtifactRun[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [reply, setReply] = useState('')
  const [checkpointId, setCheckpointId] = useState('')
  const [pauseAfterReply, setPauseAfterReply] = useState(false)
  const [isSavingReply, setIsSavingReply] = useState(false)
  const [isRecovering, setIsRecovering] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)

  const workspace = workspaces.find((item) => item.id === artifactWorkspaceId)
  const selectedRun = useMemo(
    () => runs.find((run) => run.conversationId === selectedId) || runs[0],
    [runs, selectedId]
  )

  const refresh = async () => {
    if (!artifactWorkspaceId) {
      setRuns([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const nextRuns = await window.eva.task.listArtifacts(artifactWorkspaceId)
      setRuns(nextRuns)
      setSelectedId((current) => current && nextRuns.some((run) => run.conversationId === current) ? current : nextRuns[0]?.conversationId || null)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [artifactWorkspaceId])

  const hasActiveRun = runs.some((run) => run.status === 'queued' || run.status === 'running')

  useEffect(() => {
    if (!hasActiveRun) return
    // A background Goal continues after its initiating chat turn completes.
    // Poll only while something is active so a terminal result replaces the
    // spinner without requiring the user to leave and reopen this page.
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => window.clearInterval(timer)
  }, [artifactWorkspaceId, hasActiveRun])

  const openConversation = (conversationId: string) => {
    void selectConversation(conversationId)
    closeTaskArtifacts()
  }

  const submitReply = async () => {
    if (!selectedRun || !reply.trim()) return
    setIsSavingReply(true)
    setReplyError(null)
    try {
      await window.eva.task.addFeedback(selectedRun.conversationId, reply, checkpointId || undefined, pauseAfterReply)
      setReply('')
      setPauseAfterReply(false)
      await refresh()
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : 'Could not save task feedback.')
    } finally {
      setIsSavingReply(false)
    }
  }

  const resumeTask = async () => {
    if (!selectedRun) return
    setIsRecovering(true)
    setReplyError(null)
    try {
      const resumedInProcess = await window.eva.task.resumeFromCheckpoint(selectedRun.conversationId)
      // After a restart there is no live planner to unpause. Re-enqueue the
      // saved Goal so its planner can skip completed steps from the snapshot.
      if (!resumedInProcess) await window.eva.task.resume(selectedRun)
      setRuns((current) => current.map((run) => run.conversationId === selectedRun.conversationId
        ? { ...run, status: resumedInProcess ? 'running' : 'queued', error: undefined }
        : run
      ))
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : 'Could not resume this task.')
    } finally {
      setIsRecovering(false)
    }
  }

  const recoverTask = async () => {
    if (!selectedRun) return
    setIsRecovering(true)
    setReplyError(null)
    try {
      await window.eva.task.resume(selectedRun)
      setRuns((current) => current.map((run) => run.conversationId === selectedRun.conversationId
        ? { ...run, status: 'queued', error: undefined }
        : run
      ))
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : 'Could not recover this task.')
    } finally {
      setIsRecovering(false)
    }
  }

  const stopTask = async () => {
    if (!selectedRun) return
    setReplyError(null)
    try {
      await window.eva.task.cancel(selectedRun.conversationId)
      setRuns((current) => current.map((run) => run.conversationId === selectedRun.conversationId
        ? { ...run, status: 'cancelled', error: undefined }
        : run
      ))
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : 'Could not stop this task.')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex h-16 shrink-0 items-center border-b border-zinc-200 px-8">
        <div className="flex min-w-0 items-center gap-3">
          <FolderKanban className="h-5 w-5 shrink-0 text-violet-600" />
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-zinc-900">Task artifacts</h1>
            <p className="truncate text-xs text-zinc-500">{workspace?.name || 'Project'} · Plans, work, sources, and generated files</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" className="ml-auto gap-2" onClick={closeTaskArtifacts}>
          <ArrowLeft className="h-4 w-4" />
          Back to workspace
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-zinc-100 px-4 py-5">
          <div className="mb-3 flex items-center justify-between px-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Task runs</span>
            <button type="button" onClick={() => void refresh()} className="text-xs text-zinc-400 hover:text-violet-700">Refresh</button>
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2 px-2 py-4 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading artifacts</div>
          ) : runs.length === 0 ? (
            <p className="px-2 py-4 text-sm leading-6 text-zinc-500">Goal and Team tasks in this project will appear here after they begin.</p>
          ) : (
            <div className="space-y-1">
              {runs.map((run) => (
                <button
                  key={run.conversationId}
                  type="button"
                  onClick={() => setSelectedId(run.conversationId)}
                  className={cn(
                    'w-full rounded-md px-3 py-3 text-left transition-colors',
                    selectedRun?.conversationId === run.conversationId ? 'bg-violet-50 text-zinc-900' : 'hover:bg-zinc-50 text-zinc-700'
                  )}
                >
                  <div className="flex gap-2">
                    <StatusIcon status={run.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{run.conversationTitle}</span>
                      <span className="mt-1 block truncate text-xs text-zinc-500">{run.goal}</span>
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto px-10 py-8">
          {!selectedRun ? (
            <div className="mx-auto flex max-w-xl flex-col items-start pt-20 text-zinc-500">
              <FileOutput className="mb-5 h-8 w-8 text-zinc-300" />
              <h2 className="text-lg font-semibold text-zinc-800">No task artifacts yet</h2>
              <p className="mt-2 leading-7">Run a Goal or Team task from a conversation. Eva will retain its plan, progress, sources and generated files here.</p>
            </div>
          ) : (
            <div className="mx-auto max-w-4xl">
              {(() => {
                const hasCheckpointedPlan = selectedRun.steps.length > 0
                const canRecover = selectedRun.status === 'interrupted' || selectedRun.status === 'failed' || selectedRun.status === 'cancelled'
                const isPaused = selectedRun.status === 'paused'
                const recoveryLabel = hasCheckpointedPlan ? 'Continue from checkpoint' : 'Retry goal'
                return <>
              <div className="flex items-start gap-4 border-b border-zinc-100 pb-7">
                <StatusIcon status={selectedRun.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h2 className="text-xl font-semibold text-zinc-900">{selectedRun.conversationTitle}</h2>
                    <span className={cn('text-xs font-medium', statusMeta[selectedRun.status].className)}>{statusMeta[selectedRun.status].label}</span>
                    <span className="text-xs text-zinc-400">{selectedRun.kind === 'expert' ? 'Team task' : 'Goal task'}</span>
                  </div>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">{selectedRun.goal}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => openConversation(selectedRun.conversationId)}>Open conversation</Button>
                {(selectedRun.status === 'running' || selectedRun.status === 'queued') && (
                  <Button variant="ghost" size="sm" className="gap-1.5 text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => void stopTask()}>
                    <StopCircle className="h-3.5 w-3.5" /> Stop task
                  </Button>
                )}
                {selectedRun.status === 'paused' && (
                  <Button variant="outline" size="sm" className="gap-1.5" disabled={isRecovering} onClick={() => void resumeTask()}>
                    {isRecovering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Continue
                  </Button>
                )}
                {canRecover && (
                  <Button variant="outline" size="sm" className="gap-1.5" disabled={isRecovering} onClick={() => void recoverTask()}>
                    {isRecovering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} {recoveryLabel}
                  </Button>
                )}
              </div>

              {(isPaused || canRecover) && (
                <p className="mt-4 text-sm leading-6 text-zinc-500">
                  {hasCheckpointedPlan
                    ? 'Completed steps, checkpoints, and task guidance are retained. Continuing runs only the remaining work.'
                    : 'This older task has no saved plan. Retrying will create a new plan from its original request.'}
                </p>
              )}

              <Section title="Plan and progress" count={selectedRun.steps.length}>
                <div className="divide-y divide-zinc-100">
                  {selectedRun.steps.length === 0 ? (
                    <p className="py-3 text-sm text-zinc-500">The task has not produced a plan yet.</p>
                  ) : selectedRun.steps.map((step) => (
                    <div key={step.id} className="flex items-start gap-3 py-3.5">
                      <StatusIcon status={step.status || 'pending'} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-zinc-800">{step.title}</p>
                        {step.detail && <p className="mt-1 text-xs text-zinc-500">{step.detail}</p>}
                        {step.result && <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-600">{step.result}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>

              <Section title="Checkpoints and replies" count={selectedRun.checkpoints.length}>
                <div className="divide-y divide-zinc-100">
                  {selectedRun.checkpoints.length === 0 ? (
                    <p className="py-2 text-sm text-zinc-500">Checkpoints appear when the plan is created and when task steps finish.</p>
                  ) : selectedRun.checkpoints.map((checkpoint) => (
                    <div key={checkpoint.id} className="py-3.5">
                      <div className="flex items-start gap-3">
                        <StatusIcon status={checkpoint.status === 'completed' ? 'completed' : checkpoint.status === 'needs_attention' ? 'failed' : 'pending'} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-zinc-800">{checkpoint.title}</p>
                          {checkpoint.description && <p className="mt-1 text-xs leading-5 text-zinc-500">{checkpoint.description}</p>}
                          {checkpoint.feedback.map((item) => (
                            <div key={item.id} className="mt-2 border-l-2 border-violet-200 pl-3 text-sm leading-6 text-zinc-600">{item.content}</div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-5 border-t border-zinc-100 pt-5">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-800">
                    <MessageSquarePlus className="h-4 w-4 text-violet-600" /> Add task guidance
                  </div>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">Your reply is retained with this task and is supplied to the remaining goal steps or team members.</p>
                  <textarea
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    placeholder="Clarify the outcome, redirect the work, or request a review..."
                    className="mt-3 min-h-24 w-full resize-y rounded-md border border-zinc-200 bg-white px-3 py-2.5 text-sm leading-6 text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none"
                    maxLength={4000}
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <select
                      value={checkpointId}
                      onChange={(event) => setCheckpointId(event.target.value)}
                      className="h-9 max-w-full rounded-md border border-zinc-200 bg-white px-2.5 text-xs text-zinc-700 outline-none focus:border-zinc-400"
                    >
                      <option value="">General task guidance</option>
                      {selectedRun.checkpoints.map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{checkpoint.title}</option>)}
                    </select>
                    {(selectedRun.status === 'running') && (
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-600">
                        <input type="checkbox" checked={pauseAfterReply} onChange={(event) => setPauseAfterReply(event.target.checked)} className="h-3.5 w-3.5 accent-violet-600" />
                        <Pause className="h-3.5 w-3.5 text-zinc-400" /> Pause after current operation
                      </label>
                    )}
                    <Button size="sm" className="ml-auto" disabled={!reply.trim() || isSavingReply} onClick={() => void submitReply()}>
                      {isSavingReply ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save reply'}
                    </Button>
                  </div>
                  {replyError && <p className="mt-3 text-xs text-red-600">{replyError}</p>}
                </div>
              </Section>

              {selectedRun.summary && (
                <Section title="Outcome" count={1}>
                  <MarkdownMessageContent content={selectedRun.summary} className="max-w-none text-sm" />
                </Section>
              )}

              <Section title="Research sources" count={selectedRun.sources.length}>
                {selectedRun.sources.length > 0 ? (
                  <div className="divide-y divide-zinc-100">{selectedRun.sources.map((item) => <ArtifactRow key={item.id} item={item} icon={Globe2} />)}</div>
                ) : <p className="py-2 text-sm text-zinc-500">No web research was recorded for this task.</p>}
              </Section>

              <Section title="Generated files" count={selectedRun.files.length}>
                {selectedRun.files.length > 0 ? (
                  <div className="divide-y divide-zinc-100">{selectedRun.files.map((item) => <ArtifactRow key={item.id} item={item} icon={FileText} />)}</div>
                ) : <p className="py-2 text-sm text-zinc-500">No files were written by the recorded task steps.</p>}
              </Section>

              <Section title="Tool activity" count={selectedRun.tools.length}>
                {selectedRun.tools.length > 0 ? (
                  <div className="divide-y divide-zinc-100">{selectedRun.tools.map((item) => <ArtifactRow key={item.id} item={item} icon={TerminalSquare} />)}</div>
                ) : <p className="py-2 text-sm text-zinc-500">No tool calls were retained for this task.</p>}
              </Section>

              {selectedRun.error && <p className="mb-8 border-l-2 border-red-300 pl-3 text-sm leading-6 text-red-700">{selectedRun.error}</p>}
                </>
              } )()}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
