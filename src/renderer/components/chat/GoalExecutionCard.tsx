import React, { useEffect, useState } from 'react'
import { CheckCircle2, ChevronRight, Circle, Loader2, Target, XCircle } from 'lucide-react'
import type { GoalStep, TaskStatus } from '../../../shared/types/task'
import { EMPTY_GOAL_TASK, useTaskStore } from '@/stores/use-task-store'
import { cn } from '@/lib/utils'
import { ToolCallView } from './ToolCallView'

const statusIcon: Record<TaskStatus, React.ReactNode> = {
  pending: <Circle className="h-4 w-4 text-zinc-400" />,
  in_progress: <Loader2 className="h-4 w-4 animate-spin text-violet-600" />,
  completed: <CheckCircle2 className="h-4 w-4 text-emerald-600" />,
  failed: <XCircle className="h-4 w-4 text-red-600" />,
  cancelled: <XCircle className="h-4 w-4 text-zinc-500" />,
}

function StepRow({ step }: { step: GoalStep }) {
  const [expanded, setExpanded] = useState(step.status === 'in_progress')

  useEffect(() => {
    if (step.status === 'in_progress') setExpanded(true)
  }, [step.status])

  const hasDetails = Boolean(step.result || step.toolCalls?.length)

  return (
    <div className={cn(
      'border-b border-zinc-100 last:border-0',
      step.status === 'in_progress' && 'bg-violet-50/60',
      step.status === 'failed' && 'bg-red-50/50',
    )}>
      <button
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
        onClick={() => hasDetails && setExpanded((value) => !value)}
        disabled={!hasDetails}
      >
        <span className="mt-0.5 shrink-0">{statusIcon[step.status]}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-zinc-800">Step {step.index + 1}</span>
          <span className="mt-0.5 block text-sm leading-5 text-zinc-600">{step.description}</span>
        </span>
        {hasDetails && (
          <ChevronRight className={cn('mt-1 h-4 w-4 shrink-0 text-zinc-400 transition-transform', expanded && 'rotate-90')} />
        )}
      </button>

      {expanded && hasDetails && (
        <div className="space-y-2 border-t border-zinc-100 bg-white/70 px-4 py-3">
          {step.toolCalls?.map((toolCall) => (
            <ToolCallView key={toolCall.id} toolCall={toolCall} />
          ))}
          {step.result && (
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-2.5 text-xs leading-5 text-zinc-600">
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
  const { progress: goalProgress, isRunning: isGoalRunning, streamingContent: goalStreamingContent } = goalTask

  if (!goalProgress || goalProgress.conversationId !== conversationId) return null

  const completed = goalProgress.steps.filter((step) => step.status === 'completed').length
  const total = goalProgress.steps.length
  const activeStep = goalProgress.steps.find((step) => step.status === 'in_progress')
  const progress = total ? Math.round((completed / total) * 100) : 0

  return (
    <section className="overflow-hidden rounded-xl border border-violet-200 bg-white shadow-sm">
      <header className="border-b border-violet-100 bg-violet-50/70 px-4 py-3">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-violet-600" />
          <span className="text-sm font-semibold text-zinc-800">Goal execution</span>
          {isGoalRunning ? (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-violet-700">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running
            </span>
          ) : goalProgress.status === 'completed' ? (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" /> Completed
            </span>
          ) : (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-red-700">
              <XCircle className="h-3.5 w-3.5" /> {goalProgress.status}
            </span>
          )}
        </div>
        <p className="mt-2 text-sm leading-5 text-zinc-700">{goalProgress.goal}</p>
        {total > 0 && (
          <div className="mt-3 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-violet-100">
              <div className="h-full rounded-full bg-violet-600 transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs tabular-nums text-zinc-500">{completed}/{total}</span>
          </div>
        )}
      </header>

      {total === 0 ? (
        <div className="flex items-center gap-2 px-4 py-4 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin text-violet-500" />
          Creating an execution plan...
        </div>
      ) : (
        <div>{goalProgress.steps.map((step) => <StepRow key={step.id} step={step} />)}</div>
      )}

      {activeStep && goalStreamingContent && (
        <div className="border-t border-violet-100 bg-violet-50/40 px-4 py-3">
          <div className="mb-1.5 text-xs font-medium text-violet-700">Live output for step {activeStep.index + 1}</div>
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap text-xs leading-5 text-zinc-600">{goalStreamingContent}</pre>
        </div>
      )}

      {goalProgress.summary && (
        <div className="border-t border-zinc-100 px-4 py-3 text-sm leading-6 text-zinc-600">
          {goalProgress.summary}
        </div>
      )}
    </section>
  )
}
