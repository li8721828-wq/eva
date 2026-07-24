import React, { useRef, useState } from 'react'
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
import evaMark from '@/assets/eva-mark.svg'

export interface SidebarProps {
  className?: string
}

export function Sidebar({ className }: SidebarProps) {
  const { sidebarCollapsed, toggleSidebar, setSettingsOpen, agentManagerOpen, setAgentManagerOpen } =
    useAppStore()
  const { createConversation } = useChatStore()
  const { addWorkspace, addWorkspaceAtPath, activeWorkspaceId, workspaces } = useWorkspaceStore()
  const { agents, selectedAgentId } = useAgentStore()
  const [isDraggingFolder, setIsDraggingFolder] = useState(false)
  const [dropMessage, setDropMessage] = useState<string | null>(null)
  const dragDepth = useRef(0)

  const activeAgent = agents.find((a) => a.id === selectedAgentId)
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)

  const isFileDrag = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files')

  const clearDropMessage = () => {
    window.setTimeout(() => setDropMessage(null), 3200)
  }

  const getDroppedPath = (file: File): string => {
    const legacyPath = (file as File & { path?: string }).path
    if (legacyPath) return legacyPath

    if (typeof window.eva.file.getPath !== 'function') {
      throw new Error('The desktop bridge needs a restart before folder drag and drop can be used.')
    }
    return window.eva.file.getPath(file)
  }

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setIsDraggingFolder(true)
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setIsDraggingFolder(false)
    }
  }

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setIsDraggingFolder(false)

    let paths: string[]
    try {
      paths = Array.from(event.dataTransfer.files).map(getDroppedPath).filter(Boolean)
    } catch (err) {
      console.error('Failed to resolve dropped folder path:', err)
      setDropMessage(err instanceof Error ? err.message : 'Could not read the dropped folder.')
      clearDropMessage()
      return
    }
    if (paths.length === 0) {
      setDropMessage('Could not read the dropped folder.')
      clearDropMessage()
      return
    }

    const results = await Promise.allSettled(paths.map((path) => addWorkspaceAtPath(path)))
    const added = results.filter((result) => result.status === 'fulfilled').length
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    setDropMessage(
      added > 0
        ? `${added} project ${added === 1 ? 'folder' : 'folders'} added.`
        : firstFailure?.reason instanceof Error
          ? firstFailure.reason.message
          : 'Please drop a folder, not a file.'
    )
    clearDropMessage()
  }

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
        'relative flex w-[304px] shrink-0 flex-col border-r border-zinc-200 bg-[#f8f9fa]',
        className
      )}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      {isDraggingFolder && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-violet-400 bg-violet-50/95 p-6 text-center text-sm font-medium text-violet-700 shadow-sm">
          Drop a project folder to add it to Eva
        </div>
      )}
      {/* Header */}
      <div className="flex h-16 items-center justify-between border-b border-zinc-200 px-5">
        <div className="flex items-center gap-2">
          <img src={evaMark} alt="Eva" className="h-8 w-8 shrink-0" />
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
        {dropMessage && <p className="px-3 pt-1 text-xs leading-5 text-zinc-500">{dropMessage}</p>}
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
