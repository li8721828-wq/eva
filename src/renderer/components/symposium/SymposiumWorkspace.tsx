import React, { useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, MessageCircleMore, Play, UsersRound } from 'lucide-react'
import { useAgentStore } from '@/stores/use-agent-store'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useWorkspaceStore } from '@/stores/use-workspace-store'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import type { ProviderConfigEntry } from '../../../shared/types/provider'
import type { SymposiumModelParticipant } from '../../../shared/types/symposium'

function titleFromTopic(topic: string): string {
  const value = topic.replace(/\s+/g, ' ').trim()
  return value.length > 42 ? `${value.slice(0, 42)}...` : value || 'Agent Symposium'
}

function createModelHandle(providerName: string, modelName: string, index: number): string {
  const compact = `${providerName}-${modelName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'model'
  return index === 0 ? compact : `${compact}-${index + 1}`
}

export function SymposiumWorkspace() {
  const { selectedAgentId } = useAgentStore()
  const { activeWorkspaceId, workspaces } = useWorkspaceStore()
  const { setConversations, selectConversation } = useChatStore()
  const { setCurrentView } = useAppStore()
  const [savedProviders, setSavedProviders] = useState<ProviderConfigEntry[]>([])
  const [participantIds, setParticipantIds] = useState<string[]>([])
  const [topic, setTopic] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const workspace = workspaces.find((item) => item.id === activeWorkspaceId)
  const modelParticipants = useMemo<SymposiumModelParticipant[]>(() => {
    const handleCounts = new Map<string, number>()
    return savedProviders
      .filter((provider) => provider.isEnabled && Boolean(provider.apiKey))
      .flatMap((provider) => {
      const models = provider.models?.length
        ? provider.models
        : provider.defaultModel
          ? [{ id: provider.defaultModel, name: provider.defaultModel }]
          : []
        return models.map((model) => {
          const base = createModelHandle(provider.name, model.name, 0)
          const count = handleCounts.get(base) || 0
          handleCounts.set(base, count + 1)
          return {
            id: `${provider.id}:${model.id}`,
            handle: createModelHandle(provider.name, model.name, count),
            providerId: provider.id,
            providerName: provider.name,
            model: model.id,
            modelName: model.name,
          }
        })
      })
  }, [savedProviders])
  const participants = useMemo(() => modelParticipants.filter((participant) => participantIds.includes(participant.id)), [modelParticipants, participantIds])

  useEffect(() => {
    let disposed = false
    void window.eva.provider.list()
      .then((providers) => { if (!disposed) setSavedProviders(providers) })
      .catch((loadError) => { if (!disposed) setError(loadError instanceof Error ? loadError.message : 'Could not load saved model connections.') })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    if (participantIds.length === 0 && modelParticipants.length >= 2) {
      setParticipantIds(modelParticipants.slice(0, 2).map((participant) => participant.id))
    }
  }, [modelParticipants, participantIds.length])

  const toggleParticipant = (participantId: string) => {
    setParticipantIds((current) => current.includes(participantId)
      ? current.filter((id) => id !== participantId)
      : [...current, participantId]
    )
  }

  const start = async () => {
    const normalizedTopic = topic.trim()
    if (!normalizedTopic) {
      setError('Describe the topic the models should discuss.')
      return
    }
    if (participantIds.length < 2) {
      setError('Choose at least two models.')
      return
    }
    setStarting(true)
    setError(null)
    try {
      const conversation = await window.eva.conversation.create({
        title: titleFromTopic(normalizedTopic),
        agentId: selectedAgentId || '',
        mode: 'normal',
        workspaceId: workspace?.id,
        workspacePath: workspace?.path || '',
        accessScope: workspace ? 'workspace' : 'full',
        permissionLevel: workspace ? 'workspace' : 'full-access',
        symposium: { topic: normalizedTopic, participants, status: 'idle' },
      })
      setConversations([conversation, ...useChatStore.getState().conversations])
      await selectConversation(conversation.id)
      setCurrentView('chat')
      await window.eva.symposium.start({ conversationId: conversation.id, topic: normalizedTopic, participants })
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Could not start the Symposium.')
      setStarting(false)
    }
  }

  return (
    <main className="h-full overflow-y-auto bg-white">
      <div className="mx-auto w-full max-w-5xl px-8 py-10 lg:px-12 lg:py-14">
        <header className="flex flex-wrap items-start justify-between gap-5 border-b border-zinc-200 pb-8">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><UsersRound className="h-5 w-5" /></div>
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-violet-600">Shared deliberation</p>
              <h1 className="mt-2 text-2xl font-semibold text-zinc-900">Agent Symposium</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">A shared model group chat. You and every selected model see the same transcript, reply concurrently, and can address a model by @mention.</p>
            </div>
          </div>
          <Button variant="ghost" className="gap-2" onClick={() => setCurrentView('chat')}><ChevronLeft className="h-4 w-4" />Back to conversation</Button>
        </header>

        <section className="grid gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
          <div>
            <label className="block text-sm font-semibold text-zinc-900" htmlFor="symposium-topic">Discussion topic</label>
            <textarea
              id="symposium-topic"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="What should the agents examine, debate, or decide?"
              className="mt-3 min-h-36 w-full resize-y rounded-lg border border-zinc-200 bg-white px-4 py-3 text-[15px] leading-7 text-zinc-800 outline-none transition focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
            />
            <p className="mt-6 text-sm leading-6 text-zinc-500">Send a normal message to invite all models. Mention a handle such as <span className="font-mono text-violet-700">@deepseek-v4-pro</span> to address one model only; models can mention each other or you in the same room.</p>
            {error && <p className="mt-5 text-sm text-red-600">{error}</p>}
            <div className="mt-9 flex items-center gap-3">
              <Button disabled={starting || participantIds.length < 2 || !topic.trim()} className="gap-2" onClick={() => void start()}><Play className="h-4 w-4" />{starting ? 'Starting...' : 'Start Symposium'}</Button>
              <span className="text-xs leading-5 text-zinc-500">Discussion turns are read-only. Models do not run file, terminal, or web tools here.</span>
            </div>
          </div>

          <aside className="border-l border-zinc-200 pl-7">
            <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-zinc-900">Discussion models</h2><span className="text-xs text-zinc-400">Choose 2 or more</span></div>
            <div className="mt-4 space-y-1">
              {modelParticipants.map((participant) => {
                const selected = participantIds.includes(participant.id)
                return (
                  <button key={participant.id} type="button" onClick={() => toggleParticipant(participant.id)} className={cn('flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors', selected ? 'bg-violet-50 text-zinc-900' : 'hover:bg-zinc-50 text-zinc-700')}>
                    <span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border', selected ? 'border-violet-500 bg-violet-600 text-white' : 'border-zinc-300 bg-white text-transparent')}><Check className="h-3.5 w-3.5" /></span>
                    <span className="min-w-0"><span className="block truncate text-sm font-medium">{participant.modelName}</span><span className="mt-0.5 block truncate text-xs leading-5 text-zinc-500">{participant.providerName} connection <span className="ml-1 font-mono text-violet-700">@{participant.handle}</span></span></span>
                  </button>
                )
              })}
            </div>
            {modelParticipants.length === 0 && <p className="mt-4 text-sm leading-6 text-zinc-500">No enabled models are available. Add a saved model connection and select one or more models in Settings.</p>}
            {participants.length > 0 && <div className="mt-6 border-t border-zinc-200 pt-5 text-xs leading-5 text-zinc-500"><MessageCircleMore className="mr-1 inline h-3.5 w-3.5 text-violet-500" />Every message is visible to the whole group. Models reply concurrently, and a model mention is routed to that model in the next exchange.</div>}
          </aside>
        </section>
      </div>
    </main>
  )
}
