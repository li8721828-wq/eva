import React, { useState } from 'react'
import type { Conversation } from '../../../shared/types'
import type { Workspace, WorkspacePermissionLevel } from '../../../shared/types/workspace'
import { useChatStore } from '@/stores/use-chat-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Folder, FolderPlus, MessageSquare, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ScrollArea } from '@/components/ui/ScrollArea'

const permissionOptions: Array<{ value: WorkspacePermissionLevel; label: string }> = [
  { value: 'workspace', label: 'Workspace only' },
  { value: 'granted-folders', label: 'Authorized folders' },
  { value: 'full-access', label: 'Full filesystem access' },
]

function belongsToWorkspace(conversation: Conversation, workspace: Workspace): boolean {
  return conversation.workspaceId === workspace.id || (!conversation.workspaceId && conversation.workspacePath === workspace.path)
}

export interface ConversationListProps {
  className?: string
}

export function ConversationList({ className }: ConversationListProps) {
  const { conversations, currentConversationId, createConversation, deleteConversation, selectConversation } = useChatStore()
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspaceId,
    setPermissionLevel,
    setFileAccessGrants,
  } = useWorkspaceStore()
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())

  const toggleProject = (id: string) => {
    setActiveWorkspaceId(id)
    setCollapsedProjects((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const addFolderGrant = async (workspace: Workspace) => {
    const path = await window.eva.file.selectFolder()
    if (!path || workspace.fileAccessGrants.some((grant) => grant.path === path)) return
    await setFileAccessGrants(workspace.id, [...workspace.fileAccessGrants, { path, access: 'read' }])
  }

  const unassigned = conversations.filter((conversation) => !workspaces.some((workspace) => belongsToWorkspace(conversation, workspace)))

  return (
    <ScrollArea className={cn('flex-1', className)}>
      <div className="flex flex-col gap-3 px-4 py-4">
        <div className="px-2 text-xs font-medium uppercase tracking-wider text-zinc-500">Projects</div>

        {workspaces.map((workspace) => {
          const projectConversations = conversations.filter((conversation) => belongsToWorkspace(conversation, workspace))
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

              {!isCollapsed && isActive && (
                <div className="mx-3 mb-3 rounded-md border border-violet-100 bg-white p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-zinc-600">
                    <ShieldCheck className="h-3.5 w-3.5 text-violet-500" />
                    Agent permissions
                  </div>
                  <select
                    value={workspace.permissionLevel}
                    onChange={(event) => void setPermissionLevel(workspace.id, event.target.value as WorkspacePermissionLevel)}
                    className="h-8 w-full rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-700 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                    aria-label={`Permission level for ${workspace.name}`}
                  >
                    {permissionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>

                  {workspace.permissionLevel === 'granted-folders' && (
                    <div className="mt-2 space-y-1.5">
                      {workspace.fileAccessGrants.map((grant) => (
                        <div key={grant.path} className="flex items-center gap-1.5 text-xs text-zinc-500">
                          <span className="min-w-0 flex-1 truncate" title={grant.path}>{grant.path}</span>
                          <button
                            type="button"
                            onClick={() => void setFileAccessGrants(workspace.id, workspace.fileAccessGrants.filter((item) => item.path !== grant.path))}
                            className="rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600"
                            title="Remove folder access"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => void addFolderGrant(workspace)}
                        className="flex items-center gap-1.5 text-xs font-medium text-violet-600 hover:text-violet-700"
                      >
                        <FolderPlus className="h-3.5 w-3.5" />
                        Add folder
                      </button>
                    </div>
                  )}

                  {workspace.permissionLevel === 'full-access' && (
                    <p className="mt-2 text-xs leading-4 text-amber-700">The agent can access any local file path.</p>
                  )}
                </div>
              )}

              {!isCollapsed && (
                <div className="mb-2 space-y-1 px-3">
                  {projectConversations.map((conversation) => (
                    <div
                      key={conversation.id}
                      className={cn(
                        'group flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors',
                        currentConversationId === conversation.id ? 'bg-violet-100 text-violet-900' : 'text-zinc-600 hover:bg-zinc-200/70'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => selectConversation(conversation.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                        <span className="min-w-0 flex-1 truncate">{conversation.title || 'Untitled'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); void deleteConversation(conversation.id) }}
                        className="hidden rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 group-hover:block"
                        title="Delete conversation"
                        aria-label="Delete conversation"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
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
            {unassigned.map((conversation) => (
              <button key={conversation.id} onClick={() => selectConversation(conversation.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-500 hover:bg-zinc-200/70">
                <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{conversation.title || 'Untitled'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
