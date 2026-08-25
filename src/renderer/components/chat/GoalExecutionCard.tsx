import React, { useEffect, useState } from 'react'
import { CheckCircle2, ChevronRight, Circle, Loader2, StopCircle, X, XCircle } from 'lucide-react'
import type { GoalStep, TaskStatus } from '../../../shared/types/task'
import { EMPTY_GOAL_TASK, useTaskStore } from '@/stores/use-task-store'
import { cn } from '@/lib/utils'
import { ToolCallGroupView } from './ToolCallView'
import { MarkdownMessageContent } from './MessageBubble'

const SMOOTH_SPIN_CLASS = 'animate-spin'

function normalizeGoalMarkdown(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    // Goal instructions are often sent as one line containing Markdown
    // headings. Restore structural breaks before rendering them.
    .replace(/\s+(#{1,6})\s+/g, '\n\n$1 ')
    .replace(/\s+(?=(?:[-*]\s+|\d+[.)]\s+))/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function goalBrief(content: string): string {
  const plain = normalizeGoalMarkdown(content)
    .replace(/#{1,6}\s*/g, '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 190 ? `${plain.slice(0, 190).trimEnd()}...` : plain
}

const statusIcon: Record<TaskStatus, React.ReactNode> = {
  pending: <Circle className="h-4 w-4 text-zinc-400" />,
  in_progress: <Loader2 className={cn('h-4 w-4 text-violet-600', SMOOTH_SPIN_CLASS)} />,
  completed: <CheckCircle2 className="h-4 w-4 text-emerald-600" />,
  failed: <XCircle className="h-4 w-4 text-red-600" />,
  cancelled: <XCircle className="h-4 w-4 text-zinc-500" />,
}

function StepRow({ step }: { step: GoalStep }) {
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    // Keep only the live step open. Completed work remains available without
    // letting a long Goal turn the conversation into a wall of tool output.
    setExpanded(step.status === 'in_progress')
  }, [step.status])

  const hasDetails = Boolean(step.result || step.toolCalls?.length || step.attempts?.length)
  const attemptLabel = step.maxAttempts && step.maxAttempts > 1
    ? `Attempt ${step.attempt || 1}/${step.maxAttempts}`
    : undefined

  return (
    <div className={cn(
      'border-b border-zinc-100 last:border-0',
      step.status === 'in_progress' && 'bg-violet-50/40',
      step.status === 'failed' && 'bg-red-50/30',
    )}>
      <button
        className="flex w-full items-start gap-3 px-0 py-3 text-left"
        onClick={() => hasDetails && setExpanded((value) => !value)}
        disabled={!hasDetails}
      >
        <span className="mt-0.5 shrink-0">{statusIcon[step.status]}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
            Step {step.index + 1}
            {attemptLabel && <span className={cn('normal-case tracking-normal', step.status === 'in_progress' ? 'text-violet-600' : step.status === 'failed' ? 'text-rose-600' : 'text-zinc-400')}>{attemptLabel}</span>}
          </span>
          <span className="mt-1 block text-sm leading-6 text-zinc-700">{step.description}</span>
        </span>
        {hasDetails && (
          <ChevronRight className={cn('mt-1 h-4 w-4 shrink-0 text-zinc-400 transition-transform', expanded && 'rotate-90')} />
        )}
      </button>

      {expanded && hasDetails && (
        <div className="ml-7 space-y-2 border-l border-violet-100 px-3 pb-4 pt-1">
          {step.attempts?.length ? (
            <div className="space-y-1 text-xs leading-5 text-zinc-500">
              {step.attempts.map((attempt) => (
                <div key={attempt.attempt} className="flex gap-2">
                  <span className={cn('shrink-0 font-medium', attempt.status === 'failed' ? 'text-rose-600' : attempt.status === 'completed' ? 'text-emerald-600' : 'text-violet-600')}>Attempt {attempt.attempt}</span>
                  <span>{attempt.status === 'failed' ? `Connection retry: ${attempt.error || 'failed'}` : attempt.status === 'completed' ? 'Completed' : 'Retry in progress'}</span>
                </div>
              ))}
            </div>
          ) : null}
          {step.toolCalls?.length ? <ToolCallGroupView toolCalls={step.toolCalls} /> : null}
          {step.result && (
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap bg-zinc-50/80 px-3 py-2.5 text-xs leading-5 text-zinc-600">
              {step.result}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

export interface GoalExecutionCardProps {
  conversationId?: string | null
}

/** Inline progress for a Goal that was invoked from the current conversation. */
export function GoalExecutionCard({ conversationId }: GoalExecutionCardProps) {
  const goalTask = useTaskStore((state) => state.goalTasks[conversationId || ''] || EMPTY_GOAL_TASK)
  const abortGoal = useTaskStore((state) => state.abortGoal)
  const clearGoalProgress = useTaskStore((state) => state.clearGoalProgress)
  const { progress: goalProgress, isRunning: isGoalRunning, streamingContent: goalStreamingContent, recoveryStatus } = goalTask
  const [showObjective, setShowObjective] = useState(false)

  if (!goalProgress || goalProgress.conversationId !== conversationId) return null

  const completed = goalProgress.steps.filter((step) => step.status === 'completed').length
  const total = goalProgress.steps.length
  const activeStep = goalProgress.steps.find((step) => step.status === 'in_progress')
  const progress = total ? Math.round((completed / total) * 100) : 0
  const objectiveIsLong = goalProgress.goal.length > 220
  const isGoalActive = isGoalRunning || (goalProgress.status === 'in_progress' && recoveryStatus !== 'interrupted')

  return (
    <section className="max-w-3xl py-1">
      <header className="pb-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-800">Goal execution</span>
          {isGoalRunning ? (
            <div className="ml-auto flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs text-violet-700">
                <Loader2 className={cn('h-3.5 w-3.5', SMOOTH_SPIN_CLASS)} /> Running
              </span>
              <button
                type="button"
                onClick={() => conversationId && void abortGoal(conversationId)}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-red-700 transition-colors hover:bg-red-50"
                title="Stop this Goal task"
              >
                <StopCircle className="h-3.5 w-3.5" /> Stop
              </button>
            </div>
          ) : recoveryStatus === 'interrupted' ? (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-amber-700">
              <XCircle className="h-3.5 w-3.5" /> Interrupted
            </span>
          ) : isGoalActive ? (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-violet-700">
              <Loader2 className={cn('h-3.5 w-3.5', SMOOTH_SPIN_CLASS)} /> Running
            </span>
          ) : goalProgress.status === 'completed' ? (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" /> Completed
            </span>
          ) : goalProgress.status === 'cancelled' ? (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-zinc-600">
              <StopCircle className="h-3.5 w-3.5" /> Cancelled
            </span>
          ) : (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-red-700">
              <XCircle className="h-3.5 w-3.5" /> {goalProgress.status}
            </span>
          )}
          {!isGoalActive && (
            <button
              type="button"
              onClick={() => conversationId && clearGoalProgress(conversationId)}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
              title="Close this Goal card; the saved task record remains available in the task center"
            >
              <X className="h-3.5 w-3.5" /> Close
            </button>
          )}
        </div>
        <div className="mt-3 max-w-3xl">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400">
            {showObjective ? 'Full request' : 'Task brief'}
          </span>
          {!showObjective && <p className="mt-1.5 text-sm leading-6 text-zinc-600">{goalBrief(goalProgress.goal)}</p>}
          {objectiveIsLong && (
            <button
              type="button"
              onClick={() => setShowObjective((visible) => !visible)}
              className="mt-2 text-xs font-medium text-violet-700 hover:text-violet-900"
            >
              {showObjective ? 'Hide full request' : 'View full request'}
            </button>
          )}
          {showObjective && (
            <div className="mt-3 border-l border-zinc-200 pl-4">
              <MarkdownMessageContent content={normalizeGoalMarkdown(goalProgress.goal)} className="text-sm leading-7 text-zinc-600" />
            </div>
          )}
        </div>
        {total > 0 && (
          <div className="mt-3 flex max-w-3xl items-center gap-3">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-violet-100">
              <div className="h-full rounded-full bg-violet-600 transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs tabular-nums text-zinc-500">{completed}/{total}</span>
          </div>
        )}
      </header>

      {total === 0 ? (
        <div className="flex items-center gap-2 py-3 text-sm text-zinc-500">
          <Loader2 className={cn('h-4 w-4 text-violet-500', SMOOTH_SPIN_CLASS)} />
          Creating an execution plan...
        </div>
      ) : (
        <div className="max-w-3xl">{goalProgress.steps.map((step) => <StepRow key={step.id} step={step} />)}</div>
      )}

      {activeStep && goalStreamingContent && (
        <div className="mt-2 max-w-3xl border-l border-violet-200 pl-3">
          <div className="mb-1.5 text-xs font-medium text-violet-700">Live output for step {activeStep.index + 1}</div>
          <MarkdownMessageContent content={goalStreamingContent} className="max-h-44 overflow-auto text-xs leading-5 text-zinc-700" />
        </div>
      )}

      {goalProgress.summary && (
        <div className="mt-5 max-w-3xl border-t border-zinc-100 pt-4">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400">Outcome</span>
          <MarkdownMessageContent content={normalizeGoalMarkdown(goalProgress.summary)} className="mt-2 text-sm leading-7 text-zinc-700" />
        </div>
      )}
      {recoveryStatus === 'interrupted' && (
        <div className="mt-3 max-w-3xl border-l border-amber-300 bg-amber-50/40 px-3 py-2 text-sm leading-6 text-amber-800">
          Eva was closed before this goal finished. Completed steps are retained; start a new run to continue the remaining work.
        </div>
      )}
    </section>
  )
}
