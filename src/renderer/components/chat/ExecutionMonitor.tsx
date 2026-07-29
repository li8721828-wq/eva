import { useEffect, useMemo, useState } from 'react'
import { Activity, BrainCircuit, CheckCircle2, ChevronDown, Circle, Clock3, ListTree, Loader2, Wrench, XCircle } from 'lucide-react'
import type { TaskStatus } from '../../../shared/types/task'
import { useChatStore } from '@/stores/use-chat-store'
import { EMPTY_EXPERT_TASK, EMPTY_GOAL_TASK, useTaskStore } from '@/stores/use-task-store'
import { cn } from '@/lib/utils'

type MonitorItem = { id: string; label: string; status: TaskStatus | 'running'; detail?: string }

const statusStyle: Record<MonitorItem['status'], { label: string; icon: typeof Circle; className: string }> = {
  pending: { label: 'Queued', icon: Circle, className: 'text-zinc-400' },
  in_progress: { label: 'Running', icon: Loader2, className: 'text-violet-600' },
  completed: { label: 'Done', icon: CheckCircle2, className: 'text-emerald-600' },
  failed: { label: 'Needs attention', icon: XCircle, className: 'text-red-600' },
  cancelled: { label: 'Stopped', icon: XCircle, className: 'text-zinc-500' },
  running: { label: 'Running', icon: Loader2, className: 'text-violet-600' },
}

function elapsedLabel(startedAt: number | null, now: number): string {
  if (!startedAt) return 'just started'
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s elapsed`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`
}

/** A conversation-scoped monitor kept above the composer while work is running. */
export function ExecutionMonitor() {
  const {
    currentConversationId,
    isStreaming,
    streamingStatus,
    streamingToolCalls,
    streamingStartedAt,
    streamingLastActivityAt,
  } = useChatStore()
  const expertTask = useTaskStore((state) => state.expertTasks[currentConversationId || ''] || EMPTY_EXPERT_TASK)
  const goalTask = useTaskStore((state) => state.goalTasks[currentConversationId || ''] || EMPTY_GOAL_TASK)
  const [now, setNow] = useState(Date.now())
  const [expanded, setExpanded] = useState(true)

  const active = isStreaming || expertTask.isRunning || goalTask.isRunning
  const hasPlan = Boolean(expertTask.currentPlan || goalTask.progress)

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  useEffect(() => {
    if (active || hasPlan) setExpanded(true)
  }, [active, hasPlan, currentConversationId])

  const items = useMemo<MonitorItem[]>(() => {
    if (expertTask.currentPlan) {
      return expertTask.currentPlan.subtasks.map((task) => ({ id: task.id, label: task.title, status: task.status, detail: task.assignedAgentName }))
    }
    if (goalTask.progress) {
      return goalTask.progress.steps.map((step) => ({ id: step.id, label: step.description, status: step.status, detail: step.result }))
    }
    return streamingToolCalls.map((toolCall) => ({
      id: toolCall.id,
      label: toolCall.name || 'Tool call',
      status: toolCall.result ? (toolCall.isError ? 'failed' : 'completed') : 'running',
    }))
  }, [expertTask.currentPlan, goalTask.progress, streamingToolCalls])

  if (!active && !hasPlan) return null

  const source = expertTask.currentPlan || expertTask.isRunning
    ? 'team'
    : goalTask.progress || goalTask.isRunning
      ? 'goal'
      : 'chat'
  const startedAt = source === 'chat' ? streamingStartedAt : source === 'goal' ? goalTask.progress?.startedAt || null : expertTask.currentPlan?.createdAt || null
  const idleSeconds = streamingLastActivityAt ? Math.floor((now - streamingLastActivityAt) / 1000) : 0
  const phase = source === 'team'
    ? expertTask.currentPlan ? 'Executing the approved plan' : 'Creating an execution plan'
    : source === 'goal'
      ? goalTask.progress ? 'Executing the goal plan' : 'Creating an execution plan'
      : streamingStatus || 'Preparing the request'
  const waiting = source === 'chat' && isStreaming && idleSeconds >= 12 && !streamingToolCalls.some((toolCall) => !toolCall.result)
  const planLabel = hasPlan ? 'Execution plan' : items.length > 0 ? 'Live activity' : 'Execution status'
  const visibleItems = expanded ? items.slice(0, 6) : []

  return (
    <section className="shrink-0 border-t border-zinc-200 bg-zinc-50" aria-label="Execution status" aria-live="polite">
      <div className="flex min-h-11 items-center gap-3 px-5 py-2.5">
        <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', active ? 'bg-violet-100 text-violet-700' : 'bg-zinc-200 text-zinc-600')}>
          {active ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-zinc-800">{phase}</span>
            {waiting && <span className="text-xs text-amber-700">Waiting for the model response</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
            <Clock3 className="h-3 w-3" />
            <span>{active ? elapsedLabel(startedAt, now) : 'Execution finished'}</span>
            {waiting && <span>· No update for {idleSeconds}s</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900"
          aria-expanded={expanded}
          aria-controls="execution-monitor-details"
        >
          {hasPlan ? <ListTree className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
          {planLabel}
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-150', expanded && 'rotate-180')} />
        </button>
      </div>

      {expanded && (
        <div id="execution-monitor-details" className="border-t border-zinc-200 bg-white px-5 py-2">
          {visibleItems.length > 0 ? (
            <ol className="space-y-1">
              {visibleItems.map((item) => {
                const style = statusStyle[item.status]
                const Icon = style.icon
                return (
                  <li key={item.id} className="flex min-w-0 items-center gap-2 py-1 text-xs">
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', style.className, item.status === 'in_progress' || item.status === 'running' ? 'animate-spin' : '')} />
                    <span className="min-w-0 flex-1 truncate text-zinc-700" title={item.label}>{item.label}</span>
                    <span className="shrink-0 text-zinc-500">{item.detail || style.label}</span>
                  </li>
                )
              })}
              {items.length > visibleItems.length && <li className="pl-5 text-xs text-zinc-500">+{items.length - visibleItems.length} more steps</li>}
            </ol>
          ) : source === 'team' || source === 'goal' ? (
            <div className="flex items-center gap-2 py-1 text-xs text-zinc-600"><BrainCircuit className="h-3.5 w-3.5 text-violet-600" /> The agent is drafting the plan before it starts work.</div>
          ) : (
            <div className="flex items-center gap-2 py-1 text-xs text-zinc-600"><Wrench className="h-3.5 w-3.5 text-violet-600" /> Model response and tool activity will appear here.</div>
          )}
        </div>
      )}
    </section>
  )
}
