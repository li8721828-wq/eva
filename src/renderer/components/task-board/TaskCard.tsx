import React, { useState } from 'react'
import type { SubTask, TaskStatus } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import {
  ChevronRight,
  User,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
  FileText,
} from 'lucide-react'

const statusConfig: Record<
  TaskStatus,
  {
    label: string
    variant: 'default' | 'primary' | 'success' | 'destructive' | 'warning'
    icon: React.ReactNode
    dotClass: string
  }
> = {
  pending: {
    label: 'Pending',
    variant: 'default',
    icon: <Circle className="h-3.5 w-3.5" />,
    dotClass: 'bg-zinc-500',
  },
  in_progress: {
    label: 'In Progress',
    variant: 'primary',
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
    dotClass: 'bg-blue-500 animate-pulse',
  },
  completed: {
    label: 'Completed',
    variant: 'success',
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    dotClass: 'bg-green-500',
  },
  failed: {
    label: 'Failed',
    variant: 'destructive',
    icon: <XCircle className="h-3.5 w-3.5" />,
    dotClass: 'bg-red-500',
  },
  cancelled: {
    label: 'Cancelled',
    variant: 'default',
    icon: <XCircle className="h-3.5 w-3.5" />,
    dotClass: 'bg-zinc-600',
  },
}

export interface TaskCardProps {
  task: SubTask
  className?: string
}

export function TaskCard({ task, className }: TaskCardProps) {
  const [expanded, setExpanded] = useState(task.status === 'in_progress')
  const config = statusConfig[task.status]

  return (
    <div
      className={cn(
        'rounded-lg border bg-white transition-colors',
        task.status === 'in_progress'
          ? 'border-blue-300'
          : task.status === 'completed'
          ? 'border-green-300'
          : task.status === 'failed'
          ? 'border-red-300'
          : 'border-zinc-200',
        className
      )}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-2 w-full p-4 text-left transition-all duration-200"
      >
        {/* Status dot */}
        <div className={cn('h-2 w-2 rounded-full mt-1.5 shrink-0', config.dotClass)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-800 truncate flex-1 min-w-0">
              {task.title}
            </span>
            <Badge variant={config.variant} className="shrink-0 text-xs">
              <span className="flex items-center gap-1">
                {config.icon}
                {config.label}
              </span>
            </Badge>
          </div>
          {task.description && (
            <p className="text-sm text-zinc-500 mt-0.5 line-clamp-2">
              {task.description}
            </p>
          )}
        </div>
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 text-zinc-600 mt-0.5 shrink-0 transition-transform',
            expanded && 'rotate-90'
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-zinc-200 px-3 py-2 space-y-2">
          {/* Assigned agent */}
          {task.assignedAgentName && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <User className="h-3 w-3" />
              <span>{task.assignedAgentName}</span>
              {task.assignedAgentId && (
                <span className="text-zinc-600 text-[10px]">({task.assignedAgentId.slice(0, 8)})</span>
              )}
            </div>
          )}

          {/* Dependencies */}
          {task.dependencies.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <FileText className="h-3 w-3" />
              <span>
                Depends on: {task.dependencies.join(', ')}
              </span>
            </div>
          )}

          {/* Timing */}
          <div className="flex items-center gap-3">
            {task.startedAt && (
              <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                <Clock className="h-3 w-3" />
                <span>Started: {new Date(task.startedAt).toLocaleTimeString()}</span>
              </div>
            )}
            {task.completedAt && task.startedAt && (
              <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                <span>
                  Duration:{' '}
                  {Math.round((task.completedAt - task.startedAt) / 1000)}s
                </span>
              </div>
            )}
          </div>

          {/* Result */}
          {task.result && (
            <div className="mt-2">
              <div className="text-xs text-zinc-500 mb-1">Result</div>
              <pre className="text-xs text-zinc-600 bg-zinc-50 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap max-h-[200px] overflow-y-auto border border-zinc-200">
                {task.result}
              </pre>
            </div>
          )}

          {/* In-progress indicator */}
          {task.status === 'in_progress' && !task.result && (
            <div className="flex items-center gap-2 text-xs text-blue-400 py-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Worker is executing this task...</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
