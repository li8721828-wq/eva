import React, { useRef, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { ConversationList } from './ConversationList'
import { ModeSelector } from './ModeSelector'
import { Plus, Settings, PanelLeftClose, PanelLeft, Bot, FolderPlus, UsersRound } from 'lucide-react'

export interface SidebarProps {
  className?: string
  style?: React.CSSProperties
}

export function Sidebar({ className, style }: SidebarProps) {
  const { sidebarCollapsed, toggleSidebar, setSettingsOpen, agentManagerOpen, setAgentManagerOpen, setCurrentView } =
    useAppStore()
  const { createConversation } = useChatStore()
  const { addWorkspace, addWorkspaceAtPath } = useWorkspaceStore()
  const [isDraggingFolder, setIsDraggingFolder] = useState(false)
  const [dropMessage, setDropMessage] = useState<string | null>(null)
  const dragDepth = useRef(0)

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
        <Button variant="ghost" size="icon" title="New global task" onClick={() => createConversation(undefined, 'normal', null)}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" title="Add project folder" onClick={() => void addWorkspace()}>
          <FolderPlus className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" title="Agent Symposium" onClick={() => setCurrentView('symposium')}>
          <UsersRound className="h-4 w-4" />
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
        'relative flex shrink-0 flex-col bg-[#f8f9fa]',
        className
      )}
      style={style}
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
      <div className="flex h-12 items-center justify-between border-b border-zinc-200/90 px-4">
        <span className="text-sm font-semibold text-zinc-800">Workspace</span>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
            onClick={toggleSidebar}
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Global actions. Workspace conversations are created from each project's + button. */}
      <div className="space-y-2 px-4 py-4">
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-full justify-start gap-2.5 px-3"
          onClick={() => createConversation(undefined, 'normal', null)}
        >
          <Plus className="h-4 w-4" />
          <span>New global task</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-full justify-start gap-2.5 px-3"
          onClick={() => setCurrentView('symposium')}
        >
          <UsersRound className="h-4 w-4" />
          <span>Agent Symposium</span>
        </Button>
        <Button variant="ghost" size="sm" className="h-9 w-full justify-start gap-2.5 px-3" onClick={() => void addWorkspace()}>
          <FolderPlus className="h-4 w-4" />
          Add Project Folder
        </Button>
        {dropMessage && <p className="px-3 pt-1 text-xs leading-5 text-zinc-500">{dropMessage}</p>}
      </div>

      {/* Conversation list */}
      <ConversationList className="flex-1" />

      {/* Bottom section: Mode + Settings */}
      <div className="px-3 pb-2 pt-4">
        <div className="px-3 pb-2 text-xs font-medium text-zinc-500 uppercase tracking-wider">Mode</div>
        <ModeSelector />
      </div>

      <div className="px-3 pb-3 pt-1">
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
