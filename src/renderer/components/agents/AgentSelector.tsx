import React, { useState, useMemo } from 'react'
import type { AgentConfig } from '../../../shared/types'
import { useAgentStore } from '@/stores/use-agent-store'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/Input'
import { ScrollArea } from '@/components/ui/ScrollArea'
import { Badge } from '@/components/ui/Badge'
import { AGENT_ROLES } from '../../../shared/constants'
import {
  Search,
  Bot,
  Plus,
  Pencil,
  Trash2,
  Code2,
  SearchCheck,
  FlaskConical,
  Crown,
  Microscope,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'

export interface AgentSelectorProps {
  onSelect?: (agent: AgentConfig) => void
  onNew?: () => void
  onEdit?: (agent: AgentConfig) => void
  onDelete?: (agent: AgentConfig) => void
  className?: string
}

const ROLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  coder: Code2,
  reviewer: SearchCheck,
  tester: FlaskConical,
  leader: Crown,
  researcher: Microscope,
  custom: Sparkles,
}

function getRoleIcon(role: string) {
  const Icon = ROLE_ICONS[role] || Bot
  return <Icon className="h-4 w-4 shrink-0 text-violet-400" />
}

export function AgentSelector({ onSelect, onNew, onEdit, onDelete, className }: AgentSelectorProps) {
  const { agents, selectedAgentId, setSelectedAgentId } = useAgentStore()
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.role.toLowerCase().includes(q)
    )
  }, [agents, search])

  // Group: Built-in vs Custom
  const builtInAgents = useMemo(() => filtered.filter((a) => a.isBuiltIn), [filtered])
  const customAgents = useMemo(() => filtered.filter((a) => !a.isBuiltIn), [filtered])

  const renderAgentCard = (agent: AgentConfig) => (
    <button
      key={agent.id}
      onClick={() => {
        setSelectedAgentId(agent.id)
        onSelect?.(agent)
      }}
      className={cn(
        'group flex items-center gap-2 w-full rounded-lg px-3 py-2.5 text-left text-sm transition-all duration-200',
        selectedAgentId === agent.id
          ? 'bg-violet-50 text-zinc-900 border border-violet-200'
          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-800'
      )}
    >
      {getRoleIcon(agent.role)}
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{agent.name}</div>
        <div className="text-xs text-zinc-500 truncate">{agent.description}</div>
      </div>
      {agent.isBuiltIn && (
        <Badge variant="default" className="shrink-0 text-xs">
          Built-in
        </Badge>
      )}
      {/* Action buttons for custom agents */}
      {!agent.isBuiltIn && (
        <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
          {onEdit && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onEdit(agent)
              }}
              className="rounded p-1 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDelete(agent)
              }}
              className="rounded p-1 text-zinc-400 hover:text-red-500 hover:bg-zinc-200"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
    </button>
  )

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Search */}
      <div className="p-3 border-b border-zinc-200">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents..."
            className="pl-8 h-9"
          />
        </div>
      </div>

      {/* Agent list */}
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4">
          {/* Built-in agents */}
          {builtInAgents.length > 0 && (
            <div>
              <div className="flex items-center gap-2 px-3 py-1.5">
                <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                  Built-in
                </span>
                <Badge>{builtInAgents.length}</Badge>
              </div>
              <div className="space-y-0.5">{builtInAgents.map(renderAgentCard)}</div>
            </div>
          )}

          {/* Custom agents */}
          <div>
            <div className="flex items-center gap-2 px-3 py-1.5">
              <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Custom
              </span>
              <Badge>{customAgents.length}</Badge>
            </div>
            <div className="space-y-0.5">
              {customAgents.length > 0 ? (
                customAgents.map(renderAgentCard)
              ) : (
                <div className="px-2.5 py-3 text-xs text-zinc-600">
                  No custom agents yet
                </div>
              )}
            </div>
          </div>

          {filtered.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-8 px-4 text-zinc-500 text-sm">
              <Bot className="h-6 w-6 opacity-50" />
              <span>No agents found</span>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Add agent button */}
      <div className="p-2 border-t border-zinc-200">
        <Button
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={onNew}
        >
          <Plus className="h-4 w-4" />
          New Agent
        </Button>
      </div>
    </div>
  )
}
