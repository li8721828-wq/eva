import React, { useState } from 'react'
import type { ToolCall } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { ChevronRight, FileCode, Terminal, Search, Loader2, CheckCircle2, XCircle } from 'lucide-react'

function getToolIcon(name: string) {
  if (name.includes('file') || name.includes('read') || name.includes('write'))
    return <FileCode className="h-3.5 w-3.5" />
  if (name.includes('execute') || name.includes('terminal') || name.includes('command'))
    return <Terminal className="h-3.5 w-3.5" />
  if (name.includes('search'))
    return <Search className="h-3.5 w-3.5" />
  return <FileCode className="h-3.5 w-3.5" />
}

export interface ToolCallViewProps {
  toolCall: ToolCall
  className?: string
}

export function ToolCallView({ toolCall, className }: ToolCallViewProps) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = !toolCall.result && !toolCall.isError

  return (
    <div className={cn('rounded-lg border border-zinc-200 bg-zinc-50 overflow-hidden', className)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-left hover:bg-zinc-100 transition-all duration-200"
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 text-zinc-400 transition-transform', expanded && 'rotate-90')}
        />
        <span className="text-zinc-500">{getToolIcon(toolCall.name)}</span>
        <span className="text-sm font-medium text-zinc-700">{toolCall.name}</span>
        <span className="ml-auto">
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />
          ) : toolCall.isError ? (
            <XCircle className="h-3.5 w-3.5 text-red-500" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-zinc-200 px-3 py-2 space-y-2">
          <div>
            <div className="text-xs text-zinc-500 mb-1">Arguments</div>
            <pre className="text-xs text-zinc-600 bg-white rounded-lg p-2 overflow-x-auto border border-zinc-200 font-mono">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>
          {toolCall.result && (
            <div>
              <div className="text-xs text-zinc-500 mb-1">Result</div>
              <pre
                className={cn(
                  'text-xs bg-white rounded-lg p-2 overflow-x-auto max-h-48 overflow-y-auto border border-zinc-200 font-mono',
                  toolCall.isError ? 'text-red-600' : 'text-zinc-600'
                )}
              >
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
