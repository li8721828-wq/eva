import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Plus, X, Terminal, PanelBottomClose, ListTree } from 'lucide-react'
import { ActivityPanel } from '@/components/activity/ActivityPanel'

interface TerminalTab {
  id: string
  title: string
}

export interface TerminalPanelProps {
  className?: string
}

export function TerminalPanel({ className }: TerminalPanelProps) {
  const { workspacePath, toggleTerminal } = useAppStore()
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeTab, setActiveTab] = useState<string>('')
  const [output, setOutput] = useState<Record<string, string[]>>({})
  const [activeView, setActiveView] = useState<'terminal' | 'activity'>('terminal')
  const outputRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)

  // Create initial terminal tag
  useEffect(() => {
    if (tabs.length === 0 && !initializedRef.current) {
      initializedRef.current = true
      createTerminal()
    }
  }, [])

  // Listen for terminal output
  useEffect(() => {
    const cleanup = window.eva.terminal.onOutput((_event, data) => {
      const { id, data: text } = data as unknown as { id: string; data: string }
      setOutput((prev) => ({
        ...prev,
        [id]: [...(prev[id] || []), text],
      }))
    })
    return cleanup
  }, [])

  // Auto-scroll to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [output, activeTab])

  const createTerminal = async () => {
    const id = `term-${Date.now()}`
    const title = `Terminal ${tabs.length + 1}`
    setTabs((prev) => [...prev, { id, title }])
    setActiveTab(id)
    try {
      await window.eva.terminal.create(id, workspacePath || process.cwd?.() || '.')
    } catch (err) {
      console.error('Failed to create terminal:', err)
    }
  }

  const closeTerminal = async (id: string) => {
    try {
      await window.eva.terminal.destroy(id)
    } catch {
      // ignore
    }
    const newTabs = tabs.filter((t) => t.id !== id)
    setTabs(newTabs)
    if (newTabs.length === 0) {
      setActiveTab('')
      setActiveView('activity')
    } else if (activeTab === id) {
      setActiveTab(newTabs[0].id)
    }
  }

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && activeTab) {
        const input = e.currentTarget
        const command = input.value
        if (command) {
          window.eva.terminal.write(activeTab, command + '\n')
          // Show the command in output immediately
          setOutput((prev) => ({
            ...prev,
            [activeTab]: [...(prev[activeTab] || []), `$ ${command}`],
          }))
          input.value = ''
        }
      }
    },
    [activeTab]
  )

  return (
    <div className={cn('flex h-56 flex-col border-t border-zinc-200 bg-white', className)}>
      {/* Tab bar */}
      <div className="flex min-h-12 items-center justify-between border-b border-zinc-200 px-4">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          <button type="button" onClick={() => setActiveView('terminal')} className={cn('flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors', activeView === 'terminal' ? 'bg-violet-50 text-violet-700' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700')}>
            <Terminal className="h-3.5 w-3.5" />
            Terminal
          </button>
          <button type="button" onClick={() => setActiveView('activity')} className={cn('flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors', activeView === 'activity' ? 'bg-violet-50 text-violet-700' : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700')}>
            <ListTree className="h-3.5 w-3.5" />
            Activity
          </button>
          {activeView === 'terminal' && tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-sm cursor-pointer border-b-2 transition-colors',
                activeTab === tab.id
                  ? 'border-violet-600 text-zinc-800'
                  : 'border-transparent text-zinc-500 hover:text-zinc-700'
              )}
              onClick={() => setActiveTab(tab.id)}
            >
              <Terminal className="h-3 w-3" />
              <span>{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTerminal(tab.id)
                }}
                aria-label="Close terminal tab"
                className="p-0.5 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1">
          {activeView === 'terminal' && <Button variant="ghost" size="icon" className="h-8 w-8" onClick={createTerminal} title="New terminal">
            <Plus className="h-3.5 w-3.5" />
          </Button>}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={toggleTerminal}
            title="Hide terminal"
            aria-label="Hide terminal"
          >
            <PanelBottomClose className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {activeView === 'activity' ? <ActivityPanel /> : <>
        <div ref={outputRef} className="flex-1 overflow-auto bg-zinc-50 p-4 font-mono text-sm text-zinc-700">
          {activeTab && output[activeTab]?.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap">{line}</div>
          ))}
        </div>

        {activeTab && (
          <div className="flex min-h-11 items-center border-t border-zinc-200 px-4 py-2.5">
            <span className="text-zinc-400 text-sm mr-2">$</span>
            <input
              className="flex-1 bg-transparent text-sm text-zinc-800 font-mono focus:outline-none"
              placeholder="Type a command..."
              onKeyDown={handleKeyDown}
            />
          </div>
        )}
      </>}
    </div>
  )
}
