import React, { useEffect, useMemo, useState } from 'react'
import type { ActivityCategory, ActivityLogEntry } from '../../../shared/types/activity'
import { Bot, CheckCircle2, FileCode2, Info, ListTree, ShieldCheck, Terminal, Wrench, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useActivityLogStore } from '@/stores/use-activity-log-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'

type ActivityScope = 'conversation' | 'workspace' | 'all'

const categoryMeta: Record<ActivityCategory, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  agent: { label: 'Agent', icon: Bot },
  tool: { label: 'Tool', icon: Wrench },
  file: { label: 'Files', icon: FileCode2 },
  terminal: { label: 'Terminal', icon: Terminal },
  permission: { label: 'Access', icon: ShieldCheck },
  conversation: { label: 'Conversation', icon: ListTree },
  system: { label: 'System', icon: Info },
}

function EntryStatus({ entry }: { entry: ActivityLogEntry }) {
  if (entry.status === 'success') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
  if (entry.status === 'error') return <XCircle className="h-3.5 w-3.5 text-red-500" />
  return <span className="h-2 w-2 rounded-full bg-violet-400" />
}

export interface ActivityPanelProps {
  className?: string
}

export function ActivityPanel({ className }: ActivityPanelProps) {
  const { entries, isLoading, loadEntries, appendEntry } = useActivityLogStore()
  const currentConversationId = useChatStore((state) => state.currentConversationId)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const [scope, setScope] = useState<ActivityScope>('conversation')

  useEffect(() => {
    void loadEntries()
    return window.eva.activity.onEntry((_event, entry) => appendEntry(entry))
  }, [appendEntry, loadEntries])

  useEffect(() => {
    if (!currentConversationId && scope === 'conversation') setScope('workspace')
  }, [currentConversationId, scope])

  const visibleEntries = useMemo(() => {
    if (scope === 'conversation') return entries.filter((entry) => entry.conversationId === currentConversationId)
    if (scope === 'workspace') return entries.filter((entry) => entry.workspaceId === activeWorkspaceId)
    return entries
  }, [activeWorkspaceId, currentConversationId, entries, scope])

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-white', className)}>
      <div className="flex min-h-11 items-center justify-between border-b border-zinc-200 px-4">
        <div className="flex items-center gap-1" role="tablist" aria-label="Activity log scope">
          {(['conversation', 'workspace', 'all'] as ActivityScope[]).map((item) => (
            (() => {
              const unavailable = item === 'conversation' && !currentConversationId
              return (
                <button
                  key={item}
                  type="button"
                  disabled={unavailable}
                  title={unavailable ? 'Select a conversation to view its activity.' : undefined}
                  onClick={() => setScope(item)}
                  className={cn(
                    'h-7 rounded-md px-2.5 text-xs font-medium transition-colors',
                    scope === item ? 'bg-violet-50 text-violet-700' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700',
                    unavailable && 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-zinc-500'
                  )}
                >
                  {item === 'conversation' ? 'Conversation' : item === 'workspace' ? 'Workspace' : 'All activity'}
                </button>
              )
            })()
          ))}
        </div>
        <button type="button" onClick={() => void loadEntries()} className="text-xs text-zinc-400 hover:text-zinc-700">Refresh</button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-400">Loading activity...</div>
        ) : visibleEntries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-50 text-violet-500"><ListTree className="h-4 w-4" /></div>
            <p className="text-sm text-zinc-500">No activity recorded yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-100">
            {visibleEntries.map((entry) => {
              const meta = categoryMeta[entry.category]
              const Icon = meta.icon
              return (
                <div key={entry.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-50 text-zinc-500"><Icon className="h-3.5 w-3.5" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-zinc-700">{entry.summary}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
                      <span>{meta.label}</span>
                      <span>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    </div>
                  </div>
                  <EntryStatus entry={entry} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
