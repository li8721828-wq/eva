import React from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useAgentStore } from '@/stores/use-agent-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Separator } from '@/components/ui/Separator'
import { ConversationList } from './ConversationList'
import { ModeSelector } from './ModeSelector'
import { Plus, Settings, PanelLeftClose, PanelLeft, Bot, FolderPlus, ShieldAlert } from 'lucide-react'

export interface SidebarProps {
  className?: string
}

export function Sidebar({ className }: SidebarProps) {
  const { sidebarCollapsed, toggleSidebar, setSettingsOpen, agentManagerOpen, setAgentManagerOpen } =
    useAppStore()
  const { createConversation } = useChatStore()
  const { addWorkspace, activeWorkspaceId, workspaces } = useWorkspaceStore()
  const { agents, selectedAgentId } = useAgentStore()

  const activeAgent = agents.find((a) => a.id === selectedAgentId)
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)

  if (sidebarCollapsed) {
    return (
      <div className="flex flex-col items-center gap-2 w-12 border-r border-zinc-200 bg-[#f8f9fa] py-3">
        <Button variant="ghost" size="icon" onClick={toggleSidebar} title="Expand sidebar">
          <PanelLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" title="New conversation" onClick={() => createConversation()}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" title="New global conversation (full filesystem access)" onClick={() => createConversation(undefined, 'normal', null)}>
          <ShieldAlert className="h-4 w-4 text-amber-600" />
        </Button>
        <Button variant="ghost" size="icon" title="Add project folder" onClick={() => void addWorkspace()}>
          <FolderPlus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="Manage agents"
          aria-label="Manage agents"
          onClick={() => setAgentManagerOpen(true)}
        >
          <Bot className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="Settings"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex flex-col w-[304px] shrink-0 border-r border-zinc-200 bg-[#f8f9fa]',
        className
      )}
    >
      {/* Header */}
      <div className="flex h-16 items-center justify-between border-b border-zinc-200 px-5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-violet-600 text-sm font-bold text-white">
            E
          </div>
          <span className="text-lg font-semibold text-zinc-900">Eva</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={toggleSidebar} title="Collapse sidebar">
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Workspace actions */}
      <div className="space-y-2 px-4 py-4">
        <Button
          variant="outline"
          className="h-10 w-full justify-start gap-2.5 px-3"
          onClick={() => createConversation()}
        >
          <Plus className="h-4 w-4" />
          <span className="truncate">{activeWorkspace ? `New: ${activeWorkspace.name}` : 'New Conversation'}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-full justify-start gap-2.5 px-3 text-amber-700 hover:text-amber-800"
          onClick={() => createConversation(undefined, 'normal', null)}
        >
          <ShieldAlert className="h-4 w-4" />
          New Global Conversation
        </Button>
        <Button variant="ghost" size="sm" className="h-9 w-full justify-start gap-2.5 px-3" onClick={() => void addWorkspace()}>
          <FolderPlus className="h-4 w-4" />
          Add Project Folder
        </Button>
      </div>

      <Separator />

      {/* Conversation list */}
      <ConversationList className="flex-1" />

      <Separator />

      {/* Active Agent */}
      <div className="p-3">
        <button
          className={cn(
            'flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm transition-all duration-200',
            'text-zinc-600 hover:bg-zinc-200 hover:text-zinc-800'
          )}
          onClick={() => setAgentManagerOpen(true)}
        >
          <Bot className="h-4 w-4 shrink-0 text-violet-500" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-0.5">Agent</div>
            <div className="text-sm text-zinc-800 truncate">
              {activeAgent?.name || 'Select Agent'}
            </div>
          </div>
        </button>
      </div>

      <Separator />

      {/* Bottom section: Mode + Settings */}
      <div className="p-3">
        <div className="px-3 pb-2 text-xs font-medium text-zinc-500 uppercase tracking-wider">Mode</div>
        <ModeSelector />
      </div>

      <Separator />

      <div className="p-3">
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-full justify-start gap-2.5 px-3"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings className="h-4 w-4" />
          Settings
        </Button>
      </div>
    </div>
  )
}
