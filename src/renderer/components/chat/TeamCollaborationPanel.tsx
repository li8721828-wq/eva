import { useMemo } from 'react'
import { Bot, ChevronRight, Cpu, MessageSquareText, Sparkles, Users } from 'lucide-react'
import { AGENT_ROLES } from '../../../shared/constants'
import { useChatStore } from '@/stores/use-chat-store'
import { useTaskStore } from '@/stores/use-task-store'
import { Badge } from '@/components/ui/Badge'

export function TeamCollaborationPanel() {
  const { currentPlan, isTaskRunning } = useTaskStore()
  const { selectConversation } = useChatStore()

  const members = useMemo(() => {
    if (!currentPlan) return []
    const grouped = new Map<string, {
      id: string
      name: string
      role: keyof typeof AGENT_ROLES | 'custom'
      providerId?: string
      model?: string
      conversationId?: string
      tasks: string[]
      active: boolean
      dynamic: boolean
    }>()
    for (const task of currentPlan.subtasks) {
      if (!task.assignedAgentId || !task.assignedAgentName) continue
      const member = grouped.get(task.assignedAgentId) || {
        id: task.assignedAgentId,
        name: task.assignedAgentName,
        role: task.assignedRole || 'custom',
        providerId: task.assignedProviderId,
        model: task.assignedModel,
        conversationId: task.agentConversationId,
        tasks: [],
        active: false,
        dynamic: Boolean(task.isDynamicAgent),
      }
      member.tasks.push(task.title)
      member.active ||= task.status === 'in_progress'
      member.conversationId ||= task.agentConversationId
      member.dynamic ||= Boolean(task.isDynamicAgent)
      grouped.set(member.id, member)
    }
    return [...grouped.values()]
  }, [currentPlan])

  if (!currentPlan || members.length === 0) return null

  return (
    <section className="border-b border-violet-100 bg-violet-50/40 px-6 py-4">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-3 flex items-center gap-2 text-sm">
          <Users className="h-4 w-4 text-violet-600" />
          <span className="font-semibold text-zinc-800">Team collaboration</span>
          <span className="text-xs text-zinc-500">{members.length} assigned agent{members.length === 1 ? '' : 's'}</span>
          {isTaskRunning && <Badge variant="primary" className="ml-auto">Active</Badge>}
        </div>
        <div className="divide-y divide-violet-100 border-y border-violet-100 bg-white/70">
          {members.map((member) => (
            <div key={member.id} className="flex min-w-0 items-center gap-4 px-4 py-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700">
                <Bot className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-zinc-900">{member.name}</span>
                  <Badge variant="default" className="shrink-0">{AGENT_ROLES[member.role]?.label || member.role}</Badge>
                  {member.dynamic && (
                    <Badge variant="primary" className="shrink-0 gap-1">
                      <Sparkles className="h-3 w-3" /> AI-defined
                    </Badge>
                  )}
                  {member.active && <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" title="Working" />}
                </div>
                <p className="mt-1 truncate text-xs text-zinc-500">Responsible for: {member.tasks.join(' / ')}</p>
              </div>
              <div className="hidden min-w-0 items-center gap-1.5 text-xs text-zinc-600 md:flex">
                <Cpu className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                <span className="max-w-44 truncate">{member.providerId && member.model ? `${member.providerId} / ${member.model}` : 'Model resolving...'}</span>
              </div>
              <button
                type="button"
                disabled={!member.conversationId}
                onClick={() => member.conversationId && void selectConversation(member.conversationId)}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:text-zinc-400"
                title={member.conversationId ? `Open ${member.name}'s context` : 'Preparing context'}
              >
                <MessageSquareText className="h-3.5 w-3.5" />
                Context
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
