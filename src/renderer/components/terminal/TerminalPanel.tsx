import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Terminal as XtermTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Plus, X, Terminal, PanelRightClose } from 'lucide-react'
import { conversationTerminalSessionId } from '../../../shared/terminal-session'

interface TerminalTab {
  id: string
  title: string
  cwd: string
  conversationId: string | null
}

interface MountedTerminal {
  terminal: XtermTerminal
  fitAddon: FitAddon
  resizeObserver: ResizeObserver
  compositionObserver: MutationObserver
}

interface DeferredPrompt {
  data: string
  timer: ReturnType<typeof setTimeout>
}

export interface TerminalPanelProps {
  className?: string
  height?: number
}

const terminalTheme = {
  background: '#f8f9fc',
  foreground: '#243348',
  cursor: '#6259d8',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(98, 89, 216, 0.18)',
  black: '#243348',
  red: '#a83f4b',
  green: '#20734f',
  yellow: '#8f5107',
  blue: '#3f6096',
  magenta: '#7354a7',
  cyan: '#256d83',
  white: '#334155',
  brightBlack: '#526176',
  brightRed: '#c95764',
  brightGreen: '#32865d',
  brightYellow: '#ad690f',
  brightBlue: '#5274a8',
  brightMagenta: '#8969bd',
  brightCyan: '#13738d',
  brightWhite: '#1f2937',
}

const ANSI = {
  reset: '\x1b[0m',
  value: '\x1b[1;36m',
}

function highlightPlainSegment(data: string): string {
  return data
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (value) => `${ANSI.value}${value}${ANSI.reset}`)
    .replace(/\b(?:[a-f\d]{1,4}:){2,}[a-f\d:%]+\b/gi, (value) => `${ANSI.value}${value}${ANSI.reset}`)
}

function highlightPlainOutput(data: string): string {
  return data
    .split(/(\x1b\[[0-?]*[ -/]*[@-~])/)
    .map((part) => part.startsWith('\x1b') ? part : highlightPlainSegment(part))
    .join('')
}

function isPowerShellPrompt(data: string): boolean {
  const plainText = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trimEnd()
  return /(?:^|\r?\n)PS\s+[^\r\n>]+>\s*$/.test(plainText)
}

export function TerminalPanel({ className, height }: TerminalPanelProps) {
  const { workspacePath, toggleTerminal } = useAppStore()
  const { conversations, currentConversationId } = useChatStore()
  const currentConversation = conversations.find((conversation) => conversation.id === currentConversationId)
  const conversationWorkspacePath = currentConversation?.workspacePath
  const terminalWorkspacePath = conversationWorkspacePath || workspacePath || '.'
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeTab, setActiveTab] = useState<string>('')
  const visibleTabs = tabs.filter((tab) => tab.conversationId === currentConversationId)
  const terminalContainers = useRef(new Map<string, HTMLDivElement>())
  const mountedTerminals = useRef(new Map<string, MountedTerminal>())
  const outputBuffers = useRef(new Map<string, string>())
  const outputGapPending = useRef(new Set<string>())
  const deferredPrompts = useRef(new Map<string, DeferredPrompt>())
  const autoCreateRef = useRef(true)
  const previousConversationRef = useRef(currentConversationId)

  const fitTerminal = useCallback((id: string) => {
    const mounted = mountedTerminals.current.get(id)
    const container = terminalContainers.current.get(id)
    if (!mounted || !container || container.clientWidth === 0 || container.clientHeight === 0) return

    mounted.fitAddon.fit()
    void window.eva.terminal.resize(id, mounted.terminal.cols, mounted.terminal.rows)
  }, [])

  const mountTerminal = useCallback((id: string) => {
    const container = terminalContainers.current.get(id)
    if (!container || mountedTerminals.current.has(id)) return

    const terminal = new XtermTerminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      convertEol: true,
      fontFamily: '"Cascadia Mono", "Cascadia Code", "Microsoft YaHei UI", Consolas, monospace',
      fontSize: 12,
      fontWeight: 550,
      fontWeightBold: 750,
      lineHeight: 1.3,
      letterSpacing: 0,
      scrollback: 5_000,
      theme: terminalTheme,
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)

    terminal.onData((data) => {
      if (data.includes('\r')) outputGapPending.current.add(id)
      void window.eva.terminal.write(id, data)
    })

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitTerminal(id))
    })
    resizeObserver.observe(container)

    const compositionView = container.querySelector<HTMLElement>('.composition-view')
    const updateCompositionCursor = () => {
      const composing = compositionView?.classList.contains('active')
      terminal.options.theme = composing ? { ...terminalTheme, cursor: 'transparent' } : terminalTheme
    }
    const compositionObserver = new MutationObserver(updateCompositionCursor)
    if (compositionView) {
      compositionObserver.observe(compositionView, { attributes: true, attributeFilter: ['class'] })
      updateCompositionCursor()
    }

    mountedTerminals.current.set(id, { terminal, fitAddon, resizeObserver, compositionObserver })

    const bufferedOutput = outputBuffers.current.get(id)
    if (bufferedOutput) {
      terminal.write(bufferedOutput)
      outputBuffers.current.delete(id)
    }
    requestAnimationFrame(() => fitTerminal(id))
  }, [fitTerminal])

  const disposeTerminal = useCallback((id: string) => {
    const deferredPrompt = deferredPrompts.current.get(id)
    if (deferredPrompt) {
      clearTimeout(deferredPrompt.timer)
      deferredPrompts.current.delete(id)
    }
    const mounted = mountedTerminals.current.get(id)
    if (mounted) {
      mounted.resizeObserver.disconnect()
      mounted.compositionObserver.disconnect()
      mounted.terminal.dispose()
      mountedTerminals.current.delete(id)
    }
    outputBuffers.current.delete(id)
    terminalContainers.current.delete(id)
  }, [])

  const createTerminal = useCallback((primary = false) => {
    const id = primary && currentConversationId
      ? conversationTerminalSessionId(currentConversationId)
      : `term-${crypto.randomUUID()}`
    const workspaceName = terminalWorkspacePath.split(/[\\/]/).filter(Boolean).pop() || 'Terminal'
    const conversationTabCount = tabs.filter((tab) => tab.conversationId === currentConversationId).length
    const title = conversationTabCount === 0 ? workspaceName : `${workspaceName} ${conversationTabCount + 1}`
    setTabs((previousTabs) => [...previousTabs, { id, title, cwd: terminalWorkspacePath, conversationId: currentConversationId }])
    setActiveTab(id)
  }, [currentConversationId, tabs, terminalWorkspacePath])

  // A terminal belongs to its conversation, not merely to a shared workspace.
  // Two conversations in the same folder must never take over one another's shell.
  useEffect(() => {
    if (previousConversationRef.current !== currentConversationId) {
      previousConversationRef.current = currentConversationId
      autoCreateRef.current = true
    }
    const matchingTab = tabs.find((tab) => tab.conversationId === currentConversationId)
    if (matchingTab) {
      setActiveTab(matchingTab.id)
    } else if (currentConversationId && autoCreateRef.current) {
      // React development mode may run effects twice. Mark the initial
      // session claimed before scheduling it, so one conversation gets one tab.
      autoCreateRef.current = false
      void createTerminal(true)
    }
  }, [createTerminal, currentConversationId, tabs, terminalWorkspacePath])

  useEffect(() => {
    for (const tab of visibleTabs) {
      if (mountedTerminals.current.has(tab.id)) continue
      mountTerminal(tab.id)
      void window.eva.terminal.create(tab.id, tab.cwd).catch((error) => {
        console.error('Failed to create terminal:', error)
      })
    }
  }, [currentConversationId, mountTerminal, tabs])

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.conversationId !== currentConversationId) disposeTerminal(tab.id)
    }
  }, [currentConversationId, disposeTerminal, tabs])

  useEffect(() => {
    if (!activeTab) return
    requestAnimationFrame(() => {
      fitTerminal(activeTab)
      mountedTerminals.current.get(activeTab)?.terminal.focus()
    })
  }, [activeTab, fitTerminal])

  useEffect(() => {
    const writeOutput = (id: string, data: string) => {
      const highlighted = highlightPlainOutput(data)
      const mounted = mountedTerminals.current.get(id)
      if (mounted) {
        const text = outputGapPending.current.delete(id) ? `\r\n${highlighted}` : highlighted
        mounted.terminal.write(text)
      } else {
        outputBuffers.current.set(id, `${outputBuffers.current.get(id) || ''}${highlighted}`)
      }
    }

    const flushDeferredPrompt = (id: string) => {
      const deferredPrompt = deferredPrompts.current.get(id)
      if (!deferredPrompt) return
      deferredPrompts.current.delete(id)
      writeOutput(id, deferredPrompt.data)
    }

    const cleanup = window.eva.terminal.onOutput((_event, payload) => {
      const { id, data } = payload as unknown as { id: string; data: string }
      const deferredPrompt = deferredPrompts.current.get(id)
      if (deferredPrompt) {
        clearTimeout(deferredPrompt.timer)
        deferredPrompts.current.delete(id)
        writeOutput(id, data)
        writeOutput(id, deferredPrompt.data)
        return
      }

      if (!isPowerShellPrompt(data)) {
        writeOutput(id, data)
        return
      }

      const timer = setTimeout(() => flushDeferredPrompt(id), 80)
      deferredPrompts.current.set(id, { data, timer })
    })
    return () => {
      cleanup()
      for (const [id, deferredPrompt] of deferredPrompts.current) {
        clearTimeout(deferredPrompt.timer)
        flushDeferredPrompt(id)
      }
    }
  }, [])

  useEffect(() => () => {
    for (const id of mountedTerminals.current.keys()) {
      disposeTerminal(id)
    }
  }, [disposeTerminal])

  const closeTerminal = async (id: string) => {
    disposeTerminal(id)
    try {
      await window.eva.terminal.destroy(id)
    } catch {
      // The local UI can still close when the process has already exited.
    }
    const newTabs = tabs.filter((tab) => tab.id !== id)
    setTabs(newTabs)
    if (newTabs.length === 0) {
      autoCreateRef.current = false
      setActiveTab('')
    } else if (activeTab === id) {
      setActiveTab(newTabs[0].id)
    }
  }

  return (
    <div className={cn('flex h-64 flex-col border-t border-zinc-200 bg-white', className)} style={height ? { height } : undefined}>
      <div className="flex min-h-12 items-center justify-between border-b border-zinc-200 px-4">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {visibleTabs.length === 0 && <span className="flex h-8 items-center gap-1.5 px-1 text-sm text-zinc-400"><Terminal className="h-3.5 w-3.5" />No terminal</span>}
          {visibleTabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors',
                activeTab === tab.id ? 'border-violet-600 text-zinc-800' : 'border-transparent text-zinc-500 hover:text-zinc-700'
              )}
              onClick={() => setActiveTab(tab.id)}
              title="Terminal controlled by this conversation"
            >
              <Terminal className="h-3 w-3" />
              <span>{tab.title}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  void closeTerminal(tab.id)
                }}
                aria-label="Close terminal tab"
                className="rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void createTerminal()} title="New terminal for this conversation">
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleTerminal} title="Hide terminal" aria-label="Hide terminal">
            <PanelRightClose className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 bg-[#f8f9fc]">
        {visibleTabs.map((tab) => (
          <div
            key={tab.id}
            className={cn('eva-terminal h-full w-full p-3', activeTab === tab.id ? 'block' : 'hidden')}
            ref={(element) => {
              if (element) terminalContainers.current.set(tab.id, element)
            }}
          />
        ))}
      </div>
    </div>
  )
}
