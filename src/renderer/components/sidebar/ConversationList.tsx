import React, { useState } from 'react'
import type { Conversation } from '../../../shared/types'
import type { Workspace } from '../../../shared/types/workspace'
import { useChatStore } from '@/stores/use-chat-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import { cn } from '@/lib/utils'
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Folder, MessageSquare, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ScrollArea } from '@/components/ui/ScrollArea'

function belongsToWorkspace(conversation: Conversation, workspace: Workspace): boolean {
  return conversation.workspaceId === workspace.id || (!conversation.workspaceId && conversation.workspacePath === workspace.path)
}

interface ConversationRowProps {
  conversation: Conversation
  isSelected: boolean
  archived?: boolean
  onSelect: (id: string) => void
  onArchive: (id: string) => void
  onRestore: (id: string) => void
  onDelete: (id: string) => void
}

function ConversationRow({ conversation, isSelected, archived = false, onSelect, onArchive, onRestore, onDelete }: ConversationRowProps) {
  const confirmDelete = () => {
    if (window.confirm(`Permanently delete "${conversation.title || 'Untitled'}"? This cannot be undone.`)) {
      onDelete(conversation.id)
    }
  }

  return (
    <div
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
        isSelected ? 'bg-violet-100 text-violet-900' : 'text-zinc-600 hover:bg-zinc-200/70',
        archived && 'text-zinc-500'
      )}
    >
      {archived ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Archive className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <span className="min-w-0 flex-1 truncate">{conversation.title || 'Untitled'}</span>
        </div>
      ) : (
        <button type="button" onClick={() => onSelect(conversation.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <span className="min-w-0 flex-1 truncate">{conversation.title || 'Untitled'}</span>
        </button>
      )}
      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {archived ? (
          <button type="button" onClick={() => onRestore(conversation.id)} className="rounded p-1 text-zinc-400 hover:bg-violet-50 hover:text-violet-600" title="Restore conversation" aria-label="Restore conversation">
            <ArchiveRestore className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button type="button" onClick={() => onArchive(conversation.id)} className="rounded p-1 text-zinc-400 hover:bg-violet-50 hover:text-violet-600" title="Archive conversation" aria-label="Archive conversation">
            <Archive className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" onClick={confirmDelete} className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600" title="Delete permanently" aria-label="Delete conversation">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

export interface ConversationListProps {
  className?: string
}

export function ConversationList({ className }: ConversationListProps) {
  const { conversations, currentConversationId, createConversation, deleteConversation, archiveConversation, restoreConversation, selectConversation } = useChatStore()
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspaceId,
  } = useWorkspaceStore()
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())
  const [archivedOpen, setArchivedOpen] = useState(false)

  const toggleProject = (id: string) => {
    setActiveWorkspaceId(id)
    setCollapsedProjects((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const activeConversations = conversations.filter((conversation) => !conversation.archived)
  const archivedConversations = conversations.filter((conversation) => conversation.archived)
  const unassigned = activeConversations.filter((conversation) => !workspaces.some((workspace) => belongsToWorkspace(conversation, workspace)))

  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div className="flex flex-col gap-3 px-4 py-4">
        <div className="px-2 text-xs font-medium uppercase tracking-wider text-zinc-500">Projects</div>

        {workspaces.map((workspace) => {
          const projectConversations = activeConversations.filter((conversation) => belongsToWorkspace(conversation, workspace))
          const isActive = activeWorkspaceId === workspace.id
          const isCollapsed = collapsedProjects.has(workspace.id)

          return (
            <div key={workspace.id} className={cn('rounded-lg', isActive && 'bg-violet-50/70')}>
              <div className="flex items-center gap-1 px-1 py-1.5">
                <button
                  type="button"
                  onClick={() => toggleProject(workspace.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-200/70"
                >
                  {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
                  <Folder className="h-4 w-4 shrink-0 text-violet-500" />
                  <span className="truncate font-medium">{workspace.name}</span>
                  <span className="ml-auto text-xs text-zinc-400">{projectConversations.length}</span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => createConversation(undefined, 'normal', workspace.id)}
                  title={`New conversation in ${workspace.name}`}
                  aria-label={`New conversation in ${workspace.name}`}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>

              {!isCollapsed && (
                <div className="mb-2 space-y-1 px-3">
                  {projectConversations.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      isSelected={currentConversationId === conversation.id}
                      onSelect={(id) => void selectConversation(id)}
                      onArchive={(id) => void archiveConversation(id)}
                      onRestore={(id) => void restoreConversation(id)}
                      onDelete={(id) => void deleteConversation(id)}
                    />
                  ))}
                  {projectConversations.length === 0 && <p className="px-3 py-2 text-xs text-zinc-400">No conversations</p>}
                </div>
              )}
            </div>
          )
        })}

        {workspaces.length === 0 && (
          <div className="px-3 py-6 text-sm leading-6 text-zinc-400">Add a project folder to organize conversations and permissions.</div>
        )}

        {unassigned.length > 0 && (
          <div className="mt-2">
            <div className="px-2 py-1 text-xs font-medium uppercase tracking-wider text-zinc-400">Global & Unassigned</div>
            <div className="space-y-1">
              {unassigned.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  isSelected={currentConversationId === conversation.id}
                  onSelect={(id) => void selectConversation(id)}
                  onArchive={(id) => void archiveConversation(id)}
                  onRestore={(id) => void restoreConversation(id)}
                  onDelete={(id) => void deleteConversation(id)}
                />
              ))}
            </div>
          </div>
        )}

        {archivedConversations.length > 0 && (
          <div className="mt-2 border-t border-zinc-200 pt-2">
            <button type="button" onClick={() => setArchivedOpen((open) => !open)} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 hover:bg-zinc-100">
              {archivedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Archived
              <span className="ml-auto text-zinc-400">{archivedConversations.length}</span>
            </button>
            {archivedOpen && (
              <div className="mt-1 space-y-1">
                {archivedConversations.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    archived
                    isSelected={false}
                    onSelect={(id) => void selectConversation(id)}
                    onArchive={(id) => void archiveConversation(id)}
                    onRestore={(id) => void restoreConversation(id)}
                    onDelete={(id) => void deleteConversation(id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
