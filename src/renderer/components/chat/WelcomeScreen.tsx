import React, { useEffect, useState } from 'react'
import type { SpecTemplate } from '../../../shared/types/spec'
import { Button } from '@/components/ui/Button'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { Badge } from '@/components/ui/Badge'
import { MessageSquarePlus, LayoutTemplate, Cpu, RefreshCw, Bug, PlusCircle, Eye, Sparkles } from 'lucide-react'
import evaMark from '@/assets/eva-mark.svg'

export interface WelcomeScreenProps {
  className?: string
}

const ICON_MAP: Record<string, React.ReactNode> = {
  'refresh-cw': <RefreshCw className="h-4 w-4" />,
  bug: <Bug className="h-4 w-4" />,
  'plus-circle': <PlusCircle className="h-4 w-4" />,
  eye: <Eye className="h-4 w-4" />,
}

const CATEGORY_COLOR: Record<string, string> = {
  refactor: 'text-orange-500',
  bugfix: 'text-red-500',
  feature: 'text-green-500',
  review: 'text-blue-500',
}

export function WelcomeScreen({ className }: WelcomeScreenProps) {
  const { createConversation } = useChatStore()
  const { openSettings, setSpecSelectorOpen } = useAppStore()
  const [hotTemplates, setHotTemplates] = useState<SpecTemplate[]>([])

  useEffect(() => {
    window.eva.spec
      .list()
      .then((templates) => {
        // Show the first 3 templates as hot entries
        setHotTemplates(templates.slice(0, 3))
      })
      .catch(console.error)
  }, [])

  return (
    <div className={`flex flex-col items-center justify-center h-full px-6 ${className || ''}`}>
      <div className="flex w-full max-w-xl flex-col items-center gap-5 px-4 text-center">
        {/* Logo */}
        <img src={evaMark} alt="Eva" className="h-14 w-14 drop-shadow-sm" />
        <h1 className="text-2xl font-bold text-zinc-900">Welcome to Eva</h1>
        <p className="text-base text-zinc-500 leading-relaxed">
          Your AI-powered coding agent. Write, debug, refactor, and review code with intelligent assistance.
        </p>

        {/* Quick actions */}
        <div className="mt-6 grid w-full grid-cols-1 gap-3">
          <button
            className="flex min-h-20 items-start gap-4 rounded-lg border border-zinc-200 bg-white px-5 py-4 text-left transition-all duration-200 hover:border-zinc-300 hover:shadow-md"
            onClick={() => createConversation()}
          >
            <MessageSquarePlus className="h-5 w-5 text-violet-500 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-zinc-900">New Conversation</div>
              <div className="text-sm text-zinc-500 mt-0.5">Start a new coding session</div>
            </div>
          </button>

          <button
            className="flex min-h-20 items-start gap-4 rounded-lg border border-zinc-200 bg-white px-5 py-4 text-left transition-all duration-200 hover:border-zinc-300 hover:shadow-md"
            onClick={() => setSpecSelectorOpen(true)}
          >
            <LayoutTemplate className="h-5 w-5 text-violet-500 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-zinc-900">Use a Template</div>
              <div className="text-sm text-zinc-500 mt-0.5">Start from a spec template for structured tasks</div>
            </div>
          </button>

          <button
            className="flex min-h-20 items-start gap-4 rounded-lg border border-zinc-200 bg-white px-5 py-4 text-left transition-all duration-200 hover:border-zinc-300 hover:shadow-md"
            onClick={openSettings}
          >
            <Cpu className="h-5 w-5 text-violet-500 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-medium text-zinc-900">Configure Model</div>
              <div className="text-sm text-zinc-500 mt-0.5">Set up your AI provider and model</div>
            </div>
          </button>
        </div>

        {/* Hot templates quick entry */}
        {hotTemplates.length > 0 && (
          <div className="w-full mt-4">
            <div className="flex items-center gap-1.5 mb-3 px-1">
              <Sparkles className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Quick Start Templates</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {hotTemplates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => setSpecSelectorOpen(true)}
                  className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-4 text-center transition-all duration-200 hover:border-zinc-300 hover:shadow-md"
                >
                  <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 ${CATEGORY_COLOR[template.category] || 'text-zinc-500'}`}>
                    {ICON_MAP[template.icon] || <LayoutTemplate className="h-4 w-4" />}
                  </div>
                  <span className="text-sm font-medium text-zinc-700 leading-tight">{template.name}</span>
                  <Badge variant="default" className="text-xs px-1.5 py-0">
                    {template.steps.length} steps
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
