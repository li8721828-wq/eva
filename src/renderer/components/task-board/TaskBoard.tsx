import React, { useState } from 'react'
import type { SubTask } from '../../../shared/types'
import { useTaskStore } from '@/stores/use-task-store'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/ScrollArea'
import { TaskCard } from './TaskCard'
import { Button } from '@/components/ui/Button'
import { Textarea } from '@/components/ui/Textarea'
import {
  ListTodo,
  CheckCircle2,
  Loader2,
  Circle,
  XCircle,
  Play,
  StopCircle,
  Sparkles,
} from 'lucide-react'

export interface TaskBoardProps {
  className?: string
}

export function TaskBoard({ className }: TaskBoardProps) {
  const { currentPlan, isTaskRunning, summary, startExpertTask, abortExpertTask, clearPlan } =
    useTaskStore()
  const [goalInput, setGoalInput] = useState('')

  const tasks = currentPlan?.subtasks || []

  const stats = {
    total: tasks.length,
    completed: tasks.filter((t: SubTask) => t.status === 'completed').length,
    inProgress: tasks.filter((t: SubTask) => t.status === 'in_progress').length,
    pending: tasks.filter((t: SubTask) => t.status === 'pending').length,
    failed: tasks.filter((t: SubTask) => t.status === 'failed').length,
  }

  const progressPercent =
    stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0

  const handleStart = () => {
    if (!goalInput.trim()) return
    startExpertTask(goalInput.trim())
    setGoalInput('')
  }

  const handleAbort = () => {
    abortExpertTask()
  }

  return (
    <div className={cn('flex flex-col h-full bg-white', className)}>
      {/* Header */}
      <div className="border-b border-zinc-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <ListTodo className="h-4 w-4 text-violet-500" />
          <h2 className="text-sm font-medium text-zinc-800">Task Board</h2>
          {isTaskRunning && (
            <Loader2 className="h-3 w-3 text-violet-500 animate-spin ml-auto" />
          )}
        </div>
        {currentPlan && (
          <p className="text-sm text-zinc-500 mt-1 line-clamp-2">{currentPlan.goal}</p>
        )}
      </div>

      {/* Goal input (shown when no task running and no plan) */}
      {!isTaskRunning && !currentPlan && (
        <div className="border-b border-zinc-200 px-4 py-3 space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <Sparkles className="h-3 w-3" />
            <span>Enter a goal to start expert team mode</span>
          </div>
          <Textarea
            placeholder="Describe what you want the team to accomplish..."
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            className="resize-none min-h-[80px] text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                handleStart()
              }
            }}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 gap-1.5"
              onClick={handleStart}
              disabled={!goalInput.trim()}
            >
              <Play className="h-3.5 w-3.5" />
              Start Expert Team
            </Button>
          </div>
          <p className="text-xs text-zinc-400">Ctrl+Enter to start</p>
        </div>
      )}

      {/* Abort button when running */}
      {isTaskRunning && (
        <div className="border-b border-zinc-200 px-4 py-2">
          <Button
            variant="destructive"
            size="sm"
            className="w-full gap-1.5"
            onClick={handleAbort}
          >
            <StopCircle className="h-3.5 w-3.5" />
            Abort Task
          </Button>
        </div>
      )}

      {/* Clear button when done and plan exists */}
      {!isTaskRunning && currentPlan && (
        <div className="border-b border-zinc-200 px-4 py-2 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => {
              clearPlan()
            }}
          >
            Clear Plan
          </Button>
          <Button
            size="sm"
            className="flex-1 gap-1.5"
            onClick={handleStart}
          >
            <Play className="h-3.5 w-3.5" />
            New Goal
          </Button>
        </div>
      )}

      {/* Stats bar */}
      {tasks.length > 0 && (
        <div className="flex items-center gap-4 border-b border-zinc-200 px-4 py-2">
          <div className="flex items-center gap-1 text-xs text-zinc-400">
            <Circle className="h-3 w-3 text-zinc-500" />
            {stats.pending} Pending
          </div>
          <div className="flex items-center gap-1 text-xs text-blue-500">
            <Loader2 className="h-3 w-3" />
            {stats.inProgress} Active
          </div>
          <div className="flex items-center gap-1 text-xs text-green-500">
            <CheckCircle2 className="h-3 w-3" />
            {stats.completed} Done
          </div>
          {stats.failed > 0 && (
            <div className="flex items-center gap-1 text-xs text-red-500">
              <XCircle className="h-3 w-3" />
              {stats.failed} Failed
            </div>
          )}
          {/* Progress bar */}
          <div className="ml-auto flex items-center gap-2">
            <div className="w-16 h-2 bg-zinc-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-600 rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="text-xs text-zinc-500">{progressPercent}%</span>
          </div>
        </div>
      )}

      {/* Task list */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-3">
          {tasks.map((task: SubTask) => (
            <TaskCard key={task.id} task={task} />
          ))}
          {tasks.length === 0 && !currentPlan && !isTaskRunning && (
            <div className="flex flex-col items-center gap-2 py-12 text-zinc-500">
              <ListTodo className="h-8 w-8 opacity-50" />
              <span className="text-sm">No tasks yet</span>
              <span className="text-xs text-center">
                Enter a goal above to start the expert team
              </span>
            </div>
          )}
          {isTaskRunning && tasks.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-zinc-500">
              <Loader2 className="h-8 w-8 opacity-50 animate-spin" />
              <span className="text-sm">Planning...</span>
              <span className="text-xs">Leader is analyzing the goal</span>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Summary section */}
      {summary && (
        <div className="border-t border-zinc-200 px-4 py-3 max-h-[200px] overflow-y-auto">
          <div className="flex items-center gap-1.5 mb-2">
            <Sparkles className="h-3.5 w-3.5 text-amber-500" />
            <span className="text-xs font-medium text-zinc-700">Leader Summary</span>
          </div>
          <pre className="text-xs text-zinc-600 whitespace-pre-wrap leading-relaxed">
            {summary}
          </pre>
        </div>
      )}
    </div>
  )
}
