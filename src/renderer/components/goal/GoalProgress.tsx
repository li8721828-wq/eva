import React, { useState } from 'react'
import { useTaskStore } from '@/stores/use-task-store'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/ScrollArea'
import { Button } from '@/components/ui/Button'
import {
  Target,
  CheckCircle2,
  Loader2,
  Circle,
  XCircle,
  Pause,
  Play,
  StopCircle,
  Sparkles,
  RotateCcw,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react'
import type { GoalStep, TaskStatus } from '../../../shared/types/task'

const stepStatusConfig: Record<
  TaskStatus,
  { icon: React.ReactNode; dotClass: string; label: string }
> = {
  pending: {
    icon: <Circle className="h-3.5 w-3.5 text-zinc-600" />,
    dotClass: 'bg-zinc-600',
    label: 'Pending',
  },
  in_progress: {
    icon: <Loader2 className="h-3.5 w-3.5 text-violet-600 animate-spin" />,
    dotClass: 'bg-violet-500 animate-pulse',
    label: 'Running',
  },
  completed: {
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />,
    dotClass: 'bg-green-500',
    label: 'Done',
  },
  failed: {
    icon: <XCircle className="h-3.5 w-3.5 text-red-600" />,
    dotClass: 'bg-red-500',
    label: 'Failed',
  },
  cancelled: {
    icon: <XCircle className="h-3.5 w-3.5 text-zinc-500" />,
    dotClass: 'bg-zinc-600',
    label: 'Cancelled',
  },
}

export interface GoalProgressProps {
  className?: string
}

export function GoalProgress({ className }: GoalProgressProps) {
  const {
    goalProgress,
    goalStreamingContent,
    isGoalRunning,
    isGoalPaused,
    abortGoal,
    pauseGoal,
    resumeGoal,
    clearGoalProgress,
  } = useTaskStore()

  const [expandedStep, setExpandedStep] = useState<string | null>(null)

  if (!goalProgress) return null

  const steps = goalProgress.steps || []
  const completedCount = steps.filter((s) => s.status === 'completed').length
  const totalCount = steps.length
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
  const isDone = !isGoalRunning && (goalProgress.status === 'completed' || goalProgress.status === 'failed' || goalProgress.status === 'cancelled')

  return (
    <div className={cn('flex flex-col h-full bg-white', className)}>
      {/* Header */}
      <div className="border-b border-zinc-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-violet-500" />
          <h2 className="text-sm font-medium text-zinc-800">Goal Progress</h2>
          {isGoalRunning && (
            <Loader2 className="h-3 w-3 text-violet-500 animate-spin ml-auto" />
          )}
          {isDone && goalProgress.status === 'completed' && (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 ml-auto" />
          )}
          {isDone && goalProgress.status !== 'completed' && (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 ml-auto" />
          )}
        </div>
        {goalProgress.goal && (
          <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{goalProgress.goal}</p>
        )}
      </div>

      {/* Control buttons */}
      <div className="border-b border-zinc-200 px-4 py-2 flex gap-2">
        {isGoalRunning && !isGoalPaused && (
          <>
            <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={pauseGoal}>
              <Pause className="h-3.5 w-3.5" />
              Pause
            </Button>
            <Button variant="destructive" size="sm" className="flex-1 gap-1.5" onClick={abortGoal}>
              <StopCircle className="h-3.5 w-3.5" />
              Abort
            </Button>
          </>
        )}
        {isGoalRunning && isGoalPaused && (
          <>
            <Button size="sm" className="flex-1 gap-1.5" onClick={resumeGoal}>
              <Play className="h-3.5 w-3.5" />
              Resume
            </Button>
            <Button variant="destructive" size="sm" className="flex-1 gap-1.5" onClick={abortGoal}>
              <StopCircle className="h-3.5 w-3.5" />
              Abort
            </Button>
          </>
        )}
        {isDone && (
          <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={clearGoalProgress}>
            <RotateCcw className="h-3.5 w-3.5" />
            New Goal
          </Button>
        )}
      </div>

      {/* Progress bar */}
      {totalCount > 0 && (
        <div className="border-b border-zinc-200 px-4 py-2 flex items-center gap-3">
          <span className="text-xs text-zinc-500 shrink-0">
            {completedCount}/{totalCount}
          </span>
          <div className="flex-1 h-2 bg-zinc-200 rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                goalProgress.status === 'failed' || goalProgress.status === 'cancelled'
                  ? 'bg-red-500'
                  : goalProgress.status === 'completed'
                  ? 'bg-green-500'
                  : 'bg-violet-500'
              )}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="text-xs text-zinc-500 shrink-0">{progressPercent}%</span>
        </div>
      )}

      {/* Paused indicator */}
      {isGoalPaused && isGoalRunning && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 flex items-center gap-2">
          <Pause className="h-3 w-3 text-amber-600" />
          <span className="text-xs text-amber-600">Execution paused — waiting at step boundary</span>
        </div>
      )}

      {/* Step list */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1.5 p-3">
          {steps.length === 0 && isGoalRunning && (
            <div className="flex flex-col items-center gap-2 py-12 text-zinc-500">
              <Loader2 className="h-8 w-8 opacity-50 animate-spin" />
              <span className="text-sm">Planning...</span>
              <span className="text-xs">Agent is analyzing the goal</span>
            </div>
          )}

          {steps.map((step, index) => {
            const config = stepStatusConfig[step.status] || stepStatusConfig.pending
            const isExpanded = expandedStep === step.id
            const isCurrent = isGoalRunning && step.status === 'in_progress'

            return (
              <div
                key={step.id}
                className={cn(
                  'rounded-lg border transition-colors',
                  isCurrent
                    ? 'border-violet-300 bg-violet-50'
                    : step.status === 'completed'
                    ? 'border-green-300 bg-green-50/50'
                    : step.status === 'failed'
                    ? 'border-red-300 bg-red-50/50'
                    : 'border-zinc-200 bg-white'
                )}
              >
                <button
                  onClick={() => setExpandedStep(isExpanded ? null : step.id)}
                  className="flex items-start gap-2 w-full p-2.5 text-left transition-all duration-200"
                >
                  <div className={cn('h-2 w-2 rounded-full mt-1.5 shrink-0', config.dotClass)} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-600 shrink-0">#{index + 1}</span>
                      <span className="text-sm text-zinc-700 truncate flex-1 min-w-0">
                        {step.description}
                      </span>
                      <span className="shrink-0">{config.icon}</span>
                    </div>
                  </div>
                  {(step.result || isCurrent) && (
                    <ChevronRight
                      className={cn(
                        'h-3 w-3 text-zinc-600 mt-0.5 shrink-0 transition-transform',
                        isExpanded && 'rotate-90'
                      )}
                    />
                  )}
                </button>

                {isExpanded && (
                  <div className="border-t border-zinc-200/60 px-3 py-2">
                    {/* Current step live output */}
                    {isCurrent && goalStreamingContent && (
                      <div>
                        <div className="text-xs text-violet-600 mb-1 flex items-center gap-1">
                          <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          Live output
                        </div>
                        <pre className="text-xs text-zinc-600 bg-zinc-50 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap max-h-[200px] overflow-y-auto border border-zinc-200">
                          {goalStreamingContent}
                        </pre>
                      </div>
                    )}
                    {isCurrent && !goalStreamingContent && (
                      <div className="flex items-center gap-2 text-xs text-violet-600 py-1">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        <span>Executing...</span>
                      </div>
                    )}
                    {/* Completed/failed result */}
                    {!isCurrent && step.result && (
                      <div>
                        <div className="text-xs text-zinc-500 mb-1">Result</div>
                        <pre className="text-xs text-zinc-600 bg-zinc-50 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap max-h-[200px] overflow-y-auto border border-zinc-200">
                          {step.result}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </ScrollArea>

      {/* Summary section */}
      {goalProgress.summary && (
        <div className="border-t border-zinc-200 px-4 py-3 max-h-[220px] overflow-y-auto">
          <div className="flex items-center gap-1.5 mb-2">
            <Sparkles className="h-3.5 w-3.5 text-amber-500" />
            <span className="text-xs font-medium text-zinc-700">Goal Summary</span>
          </div>
          <pre className="text-xs text-zinc-600 whitespace-pre-wrap leading-relaxed">
            {goalProgress.summary}
          </pre>
        </div>
      )}
    </div>
  )
}
