import React, { useState, useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { FileCode, Eye, Edit3, Save } from 'lucide-react'

export interface CodeEditorProps {
  filePath?: string
  content?: string
  language?: string
  className?: string
}

export function CodeEditor({ filePath, content = '', language, className }: CodeEditorProps) {
  const [readOnly, setReadOnly] = useState(true)
  const [editedContent, setEditedContent] = useState(content)
  const { workspacePath } = useAppStore()

  // Sync content when file changes
  useEffect(() => {
    setEditedContent(content)
    setReadOnly(true)
  }, [filePath, content])

  const detectedLanguage = language || detectLanguage(filePath || '')

  const handleSave = async () => {
    if (!filePath || !workspacePath) return
    try {
      await window.eva.file.write(filePath, editedContent, workspacePath)
      setReadOnly(true)
    } catch (err) {
      console.error('Failed to save file:', err)
    }
  }

  return (
    <div className={cn('flex flex-col h-full bg-white', className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode className="h-4 w-4 text-zinc-400 shrink-0" />
          <span className="text-sm text-zinc-700 truncate">{filePath || 'Untitled'}</span>
          {detectedLanguage && (
            <span className="text-xs text-zinc-400 shrink-0">{detectedLanguage}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-green-600"
              onClick={handleSave}
              title="Save"
            >
              <Save className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => setReadOnly(!readOnly)}
            title={readOnly ? 'Edit' : 'Read only'}
          >
            {readOnly ? <Eye className="h-4 w-4" /> : <Edit3 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Code content - placeholder for Monaco Editor */}
      <div className="flex-1 overflow-auto">
        {readOnly ? (
          <pre className="p-4 text-sm text-zinc-800 font-mono leading-relaxed whitespace-pre-wrap">
            {editedContent || '// Select a file to view its contents'}
          </pre>
        ) : (
          <textarea
            className="w-full h-full p-4 text-sm text-zinc-800 font-mono leading-relaxed bg-transparent resize-none focus:outline-none"
            value={editedContent}
            onChange={(e) => setEditedContent(e.target.value)}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  )
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript React',
    js: 'JavaScript',
    jsx: 'JavaScript React',
    py: 'Python',
    rs: 'Rust',
    go: 'Go',
    java: 'Java',
    css: 'CSS',
    html: 'HTML',
    json: 'JSON',
    md: 'Markdown',
    sh: 'Shell',
    yaml: 'YAML',
    yml: 'YAML',
  }
  return langMap[ext || ''] || ''
}
