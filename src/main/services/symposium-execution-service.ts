import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import type { AgentConfig } from '../../shared/types/agent'
import type { ChatMessage, Conversation } from '../../shared/types/conversation'
import {
  SYMPOSIUM_TOOL_OPTIONS,
  type AgentSymposium,
  type SymposiumContinueInput,
  type SymposiumDiscussionMemory,
  type SymposiumModelParticipant,
  type SymposiumStartInput,
  type SymposiumStreamEvent,
} from '../../shared/types/symposium'
import { IPC } from '../../shared/ipc-channels'
import { AgentRunner } from '../agent-engine/agent-runner'
import { ContextManager } from '../agent-engine/context'
import { sanitizeToolHistory } from '../agent-engine/tool-history'
import type { ApplicationServices } from './application-services'
import { recordActivity } from './activity-log'
import { activeRunRegistry } from './run-registry'

type SymposiumServices = Pick<ApplicationServices,
  'storage' | 'toolRegistry' | 'providerRegistry' | 'fileService' | 'terminalService'
>

type ConversationAccess = {
  fileAccessGrants: import('../../shared/types/file-access').FileAccessGrant[]
  fullFilesystemAccess: boolean
}

export function symposiumTranscript(messages: ChatMessage[]): string {
  const visibleMessages = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-24)
    .map((message) => `${message.role === 'user' ? 'User' : message.agentName || 'Participant'}: ${message.content}`)
    .join('\n\n')
  return visibleMessages || '(The discussion has just started.)'
}

export function getSymposiumHandle(participant: SymposiumModelParticipant): string {
  return participant.handle || participant.modelName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || participant.id
}

export function mentionedSymposiumParticipants(content: string, participants: SymposiumModelParticipant[]): SymposiumModelParticipant[] {
  const normalized = content.toLowerCase()
  return participants.filter((participant) => normalized.includes(`@${getSymposiumHandle(participant).toLowerCase()}`))
}

function toolsForSymposiumParticipant(participant: SymposiumModelParticipant, legacyTools: string[], availableToolIds: Set<string>): string[] {
  return (participant.tools ?? legacyTools).filter((tool): tool is string => typeof tool === 'string' && availableToolIds.has(tool))
}

function symposiumMemoryBlock(memory: SymposiumDiscussionMemory | undefined): string {
  if (!memory) return 'No durable discussion brief has been saved yet.'
  return [
    `Objective: ${memory.objective || '(not set)'}`,
    `Agreements: ${memory.agreements.length ? memory.agreements.map((item) => `- ${item}`).join('\n') : '(none)'}`,
    `Open questions: ${memory.openQuestions.length ? memory.openQuestions.map((item) => `- ${item}`).join('\n') : '(none)'}`,
    `Action items: ${memory.actionItems.length ? memory.actionItems.map((item) => `- ${item}`).join('\n') : '(none)'}`,
  ].join('\n')
}

function conversationWorkspacePath(conversation: Conversation, fallback = ''): string {
  return conversation.workspaceId ? (conversation.workspacePath || fallback) : ''
}

async function getConversationAccess(services: SymposiumServices, conversation: Conversation): Promise<ConversationAccess> {
  if (conversation.permissionLevel === 'full-access') return { fileAccessGrants: [], fullFilesystemAccess: true }
  if (conversation.permissionLevel === 'granted-folders') {
    return { fileAccessGrants: conversation.fileAccessGrants || [], fullFilesystemAccess: false }
  }
  if (conversation.permissionLevel === 'workspace') return { fileAccessGrants: [], fullFilesystemAccess: false }
  if (conversation.accessScope === 'full') return { fileAccessGrants: [], fullFilesystemAccess: true }
  if (conversation.workspacePath) return { fileAccessGrants: [], fullFilesystemAccess: false }
  return { fileAccessGrants: services.storage.config.get('fileAccessGrants'), fullFilesystemAccess: false }
}

/** Owns one conversation-scoped shared-model response cycle. */
export class SymposiumExecutionService {
  private readonly activeRunners = activeRunRegistry.forKind<Set<AgentRunner>>('symposium-runners')
  private readonly activeAborters = activeRunRegistry.forKind<() => void>('symposium-aborter')

  constructor(private readonly services: SymposiumServices) {}

  isRunning(conversationId: string): boolean {
    return this.activeAborters.has(conversationId)
  }

  abort(conversationId: string): void {
    activeRunRegistry.transition('symposium-aborter', conversationId, 'cancelling', 'Stopped by the user.')
    this.activeAborters.get(conversationId)?.()
  }

  async run(input: SymposiumStartInput | SymposiumContinueInput, win: BrowserWindow): Promise<void> {
    const { storage } = this.services
    const conversation = await storage.conversations.getConversation(input.conversationId)
    if (!conversation) throw new Error('The Symposium conversation no longer exists.')

    const isStarting = 'participants' in input
    const existing = conversation.symposium
    const topic = isStarting ? input.topic.trim() : existing?.topic
    const userContribution = isStarting ? input.topic.trim() : input.content.trim()
    const availableToolIds = new Set(SYMPOSIUM_TOOL_OPTIONS.map((tool) => tool.id))
    const selectedTools = ((isStarting ? input.tools : existing?.tools) || [])
      .filter((tool): tool is string => typeof tool === 'string' && availableToolIds.has(tool))
    if (!topic || !userContribution) throw new Error('A Symposium needs a discussion topic or contribution.')

    const agents = await storage.agents.listAgents()
    const legacyParticipants = (existing?.participantIds || [])
      .map((id) => agents.find((agent: AgentConfig) => agent.id === id))
      .filter(Boolean) as AgentConfig[]
    const participants: SymposiumModelParticipant[] = isStarting
      ? input.participants
      : existing?.participants || legacyParticipants.map((agent) => ({
        id: `legacy:${agent.id}`,
        handle: agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || agent.id,
        providerId: agent.providerId,
        providerName: agent.name,
        model: agent.model,
        modelName: agent.model,
      }))
    const uniqueParticipants = Array.from(new Map(participants.map((participant) => [participant.id, participant])).values())
    if (uniqueParticipants.length < 2) throw new Error('Choose at least two models for a Symposium.')
    const initialMemory = isStarting
      ? input.memory || { objective: topic, agreements: [], openQuestions: [], actionItems: [], pinned: true }
      : existing?.memory || { objective: topic, agreements: [], openQuestions: [], actionItems: [], pinned: true }

    const emit = (event: Omit<SymposiumStreamEvent, 'conversationId'>): void => {
      if (!win.isDestroyed()) win.webContents.send(IPC.SYMPOSIUM_STREAM, { ...event, conversationId: input.conversationId })
    }
    const startedAt = existing?.startedAt || Date.now()
    const cycle = (existing?.responseCycles || 0) + 1
    let cancelled = false
    const aborter = (): void => {
      cancelled = true
      this.activeRunners.get(input.conversationId)?.forEach((runner) => runner.abort())
    }
    this.activeAborters.set(input.conversationId, aborter)

    const buildSymposium = (status: AgentSymposium['status'], error?: string): AgentSymposium => ({
      topic,
      participants: uniqueParticipants,
      tools: selectedTools,
      memory: initialMemory,
      status,
      startedAt,
      lastActivityAt: Date.now(),
      responseCycles: cycle,
      ...(error ? { error } : {}),
    })
    const persistSymposium = async (status: AgentSymposium['status'], error?: string): Promise<void> => {
      const latest = await storage.conversations.getConversation(input.conversationId)
      await storage.conversations.updateConversation(input.conversationId, {
        symposium: { ...buildSymposium(status, error), memory: latest?.symposium?.memory || initialMemory },
      })
    }

    await persistSymposium('running')
    emit({ type: 'started', cycle, participantCount: uniqueParticipants.length })

    const runnerSet = new Set<AgentRunner>()
    try {
      const priorMessages = await storage.conversations.getMessages(input.conversationId)
      const duplicateOpening = isStarting && priorMessages.some((message) => message.role === 'user' && message.content === userContribution)
      if (!duplicateOpening) {
        await storage.conversations.addMessage(input.conversationId, {
          id: uuidv4(), role: 'user', content: userContribution, timestamp: Date.now(),
        })
        if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, input.conversationId)
      }

      const access = await getConversationAccess(this.services, conversation)
      const workspacePath = conversationWorkspacePath(conversation, access.fullFilesystemAccess ? '' : storage.config.get('workspacePath'))
      this.activeRunners.set(input.conversationId, runnerSet)
      const runParticipant = async (participant: SymposiumModelParticipant): Promise<{ participant: SymposiumModelParticipant; content: string; error?: string }> => {
        const provider = this.services.providerRegistry.get(participant.providerId)
        if (!provider) throw new Error(`${participant.providerName} / ${participant.modelName} is not an enabled model connection.`)
        const seatName = `${participant.providerName} / ${participant.modelName}`
        const runnerTools = toolsForSymposiumParticipant(participant, selectedTools, availableToolIds)
        const effectiveAgent: AgentConfig = {
          id: `symposium:${participant.id}`,
          name: seatName,
          description: 'Independent model participant in a shared discussion.',
          role: 'custom',
          systemPrompt: runnerTools.length
            ? `You are an independent model participant in Eva's shared discussion. Use only the tools explicitly available to you when evidence or a concrete workspace change is needed. All filesystem operations are constrained by this conversation's configured access. When editing a file, read its current contents first and state the path and result in your response so other participants can coordinate.`
            : 'You are an independent model participant in Eva\'s shared discussion. Give a concise, evidence-aware contribution that advances the discussion. You do not have tools in this discussion.',
          providerId: participant.providerId,
          model: participant.model,
          tools: runnerTools,
          maxIterations: runnerTools.length ? 12 : 1,
          temperature: 0.55,
          isBuiltIn: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        emit({ type: 'speaker_started', agentId: participant.id, agentName: seatName, cycle, participantCount: uniqueParticipants.length })
        const history = sanitizeToolHistory(await storage.conversations.getMessages(input.conversationId))
        const handles = uniqueParticipants.map((candidate) => `@${getSymposiumHandle(candidate)} (${candidate.providerName} / ${candidate.modelName})`).join(', ')
        const discussionPrompt: ChatMessage = {
          id: uuidv4(),
          conversationId: input.conversationId,
          role: 'user',
          content: `You are participating in Eva's shared model group chat.\n\nTopic: ${topic}\n\nPinned discussion brief:\n${symposiumMemoryBlock(initialMemory)}\n\nAll participants, including the user, share this transcript:\n${symposiumTranscript(history)}\n\nYou are the ${seatName} model seat, addressed in chat as @${getSymposiumHandle(participant)}. Available model mentions: ${handles}. You may address the user as @user, or mention another model when a focused follow-up from it would be useful. Directly address the latest relevant message, build on or challenge prior points, and keep your contribution concrete and concise (up to three short paragraphs). Do not repeat a sentence, status update, or evidence already present in the transcript or in your own response.${runnerTools.length ? ` You may use only these enabled tools when useful: ${runnerTools.join(', ')}. Do not claim a tool action unless its result confirms it.` : ' Do not call tools or claim to have changed files.'}`,
          timestamp: Date.now(),
        }
        const runner = new AgentRunner({
          conversationId: input.conversationId,
          agentConfig: effectiveAgent,
          provider,
          toolRegistry: this.services.toolRegistry,
          contextManager: new ContextManager({ environmentRules: storage.config.get('environmentRules') }),
          workspacePath,
          fileAccessGrants: access.fileAccessGrants,
          fullFilesystemAccess: access.fullFilesystemAccess,
          fileService: this.services.fileService,
          terminalService: this.services.terminalService,
          modelPools: storage.config.get('modelPools'),
          providerRegistry: this.services.providerRegistry,
        })
        runnerSet.add(runner)
        let content = ''
        let error: string | undefined
        try {
          for await (const agentEvent of runner.run({ messages: history, newMessage: discussionPrompt })) {
            if (agentEvent.type === 'text' && agentEvent.content) content += agentEvent.content
            if (agentEvent.type === 'done' && agentEvent.content) content = agentEvent.content
            if (agentEvent.type === 'error') error = agentEvent.error || 'The participant could not respond.'
          }
        } finally {
          runnerSet.delete(runner)
        }
        if (cancelled) return { participant, content, error: 'The discussion was stopped.' }
        const fallbackContent = error?.startsWith('Tool-use limit')
          ? `_${seatName} reached the tool-use limit before producing a final response. Any completed tool results remain available in the activity log._`
          : `_${seatName} could not contribute: ${error || 'empty response'}_`
        await storage.conversations.addMessage(input.conversationId, {
          id: uuidv4(), role: 'assistant', content: content.trim() || fallbackContent,
          agentId: participant.id, agentName: seatName, providerId: participant.providerId,
          providerName: participant.providerName, model: participant.model, timestamp: Date.now(),
        })
        if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, input.conversationId)
        emit({ type: 'speaker_completed', agentId: participant.id, agentName: seatName, cycle, participantCount: uniqueParticipants.length })
        return { participant, content, error }
      }

      const initialTargets = mentionedSymposiumParticipants(userContribution, uniqueParticipants)
      let pendingParticipants = initialTargets.length ? initialTargets : uniqueParticipants
      const alreadyResponded = new Set<string>()
      while (pendingParticipants.length && !cancelled) {
        const batch = pendingParticipants.filter((participant) => !alreadyResponded.has(participant.id))
        if (!batch.length) break
        batch.forEach((participant) => alreadyResponded.add(participant.id))
        const results = batch.some((participant) => toolsForSymposiumParticipant(participant, selectedTools, availableToolIds).includes('write_file'))
          ? await batch.reduce<Promise<Array<{ participant: SymposiumModelParticipant; content: string; error?: string }>>>(
            async (pending, participant) => [...await pending, await runParticipant(participant)],
            Promise.resolve([]),
          )
          : await Promise.all(batch.map((participant) => runParticipant(participant)))
        if (cancelled) break
        const nextIds = new Set<string>()
        for (const result of results) {
          for (const mentioned of mentionedSymposiumParticipants(result.content, uniqueParticipants)) {
            if (!alreadyResponded.has(mentioned.id) && mentioned.id !== result.participant.id) nextIds.add(mentioned.id)
          }
        }
        pendingParticipants = uniqueParticipants.filter((participant) => nextIds.has(participant.id))
      }

      await persistSymposium('idle')
      emit({ type: cancelled ? 'cancelled' : 'completed', cycle, participantCount: uniqueParticipants.length })
      void recordActivity({
        category: 'agent',
        action: cancelled ? 'symposium.cancelled' : 'symposium.responded',
        status: cancelled ? 'info' : 'success',
        summary: cancelled ? 'Model Symposium response cycle was stopped.' : `Model Symposium completed one response cycle with ${uniqueParticipants.length} model seats.`,
        conversationId: input.conversationId,
        workspaceId: conversation.workspaceId,
      }, win)
    } catch (error: any) {
      const message = error?.message ?? String(error)
      await persistSymposium('failed', message)
      emit({ type: 'error', error: message })
      if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, input.conversationId)
    } finally {
      if (this.activeRunners.get(input.conversationId) === runnerSet) this.activeRunners.delete(input.conversationId)
      if (this.activeAborters.get(input.conversationId) === aborter) this.activeAborters.delete(input.conversationId)
    }
  }
}
