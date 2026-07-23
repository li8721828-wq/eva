import React, { useState, useEffect, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { ScrollArea } from '@/components/ui/ScrollArea'
import { Folder, FolderOpen, File, ChevronRight, RefreshCw, FolderPlus } from 'lucide-react'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

export interface FileExplorerProps {
  onFileSelect?: (path: string) => void
  className?: string
}

function TreeNode({
  node,
  depth,
  onFileSelect,
  workspacePath,
}: {
  node: FileNode
  depth: number
  onFileSelect?: (path: string) => void
  workspacePath: string
}) {
  const [expanded, setExpanded] = useState(depth < 1)
  const [children, setChildren] = useState<FileNode[]>(node.children || [])
  const [loaded, setLoaded] = useState(depth < 1)
  const isDir = node.type === 'directory'

  const loadChildren = async () => {
    if (!isDir || !workspacePath) return
    try {
      const entries = await window.eva.file.tree(node.path, workspacePath)
      const childNodes: FileNode[] = (entries as any[]).map((e: any) => ({
        name: e.name,
        path: e.path,
        type: e.isDirectory ? 'directory' as const : 'file' as const,
      }))
      setChildren(childNodes)
      setLoaded(true)
    } catch (err) {
      console.error('Failed to load directory:', err)
    }
  }

  const handleClick = async () => {
    if (isDir) {
      if (!expanded && !loaded) {
        await loadChildren()
      }
      setExpanded(!expanded)
    } else {
      onFileSelect?.(node.path)
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 text-sm text-left text-zinc-600 hover:bg-zinc-100 hover:text-zinc-800 rounded-md transition-all duration-200"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isDir && (
          <ChevronRight
            className={cn('h-3 w-3 text-zinc-400 transition-transform shrink-0', expanded && 'rotate-90')}
          />
        )}
        {!isDir && <span className="w-3 shrink-0" />}
        {isDir ? (
          expanded ? (
            <FolderOpen className="h-3.5 w-3.5 text-violet-500 shrink-0" />
          ) : (
            <Folder className="h-3.5 w-3.5 text-violet-500 shrink-0" />
          )
        ) : (
          <File className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && expanded && children.map((child) => (
        <TreeNode key={child.path} node={child} depth={depth + 1} onFileSelect={onFileSelect} workspacePath={workspacePath} />
      ))}
    </div>
  )
}

export function FileExplorer({ onFileSelect, className }: FileExplorerProps) {
  const { workspacePath, setCurrentFile } = useAppStore()
  const [rootNodes, setRootNodes] = useState<FileNode[]>([])
  const [loading, setLoading] = useState(false)

  const loadRootTree = useCallback(async () => {
    if (!workspacePath) {
      setRootNodes([])
      return
    }
    setLoading(true)
    try {
      const entries = await window.eva.file.tree(workspacePath, workspacePath)
      const nodes: FileNode[] = (entries as any[]).map((e: any) => ({
        name: e.name,
        path: e.path,
        type: e.isDirectory ? 'directory' as const : 'file' as const,
      }))
      setRootNodes(nodes)
    } catch (err) {
      console.error('Failed to load file tree:', err)
    } finally {
      setLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    loadRootTree()
  }, [loadRootTree])

  const handleFileSelect = async (filePath: string) => {
    try {
      const content = await window.eva.file.read(filePath, workspacePath)
      const ext = filePath.split('.').pop()?.toLowerCase() || ''
      setCurrentFile({ path: filePath, content, language: ext })
      onFileSelect?.(filePath)
    } catch (err) {
      console.error('Failed to read file:', err)
    }
  }

  const handleBrowseFolder = async () => {
    try {
      const path = await window.eva.file.selectFolder()
      if (path) {
        useAppStore.getState().setWorkspacePath(path)
      }
    } catch (err) {
      console.error('Failed to select folder:', err)
    }
  }

  return (
    <div className={cn('flex flex-col h-full bg-white', className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <span className="text-sm font-medium text-zinc-700">Files</span>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Open folder" onClick={handleBrowseFolder}>
            <FolderPlus className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Refresh" onClick={loadRootTree} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Tree */}
      <ScrollArea className="flex-1">
        <div className="py-1">
          {rootNodes.length === 0 && !loading && (
            <div className="flex flex-col items-center gap-2 py-8 px-4 text-zinc-400 text-sm">
              <Folder className="h-6 w-6 opacity-50" />
              <span>{workspacePath ? 'Empty directory' : 'No workspace selected'}</span>
              {!workspacePath && (
                <Button variant="outline" size="sm" onClick={handleBrowseFolder}>
                  Open Folder
                </Button>
              )}
            </div>
          )}
          {rootNodes.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              onFileSelect={handleFileSelect}
              workspacePath={workspacePath}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
