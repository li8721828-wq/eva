import fs from 'fs'
import path from 'path'
import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { Conversation, ChatImageAttachment, ChatMessage, ToolCall, ChatStreamEvent } from '../../shared/types/conversation'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent'
import type { ToolRegistry, FileService, TerminalService } from '../tools'
import type { ProviderRegistry } from '../providers'
import { AgentRunner } from '../agent-engine/agent-runner'
import { ContextManager } from '../agent-engine/context'
import { TeamOrchestrator } from '../agent-engine/team-orchestrator'
import { GoalPlanner } from '../agent-engine/goal-planner'
import type { GoalEvent } from '../agent-engine/goal-planner'
import { getStorage } from '../storage'
import { v4 as uuidv4 } from 'uuid'
import { recordActivity } from '../services/activity-log'
import { sanitizeToolHistory } from '../agent-engine/tool-history'
import { SpecService } from '../services/spec-service'
import type { AutomationConfig } from '../../shared/types/automation'
import { DEFAULT_AUTOMATION_CONFIG } from '../../shared/types/automation'
import type { ChatMessageInput } from '../../shared/types/provider'
import type { GoalProgress } from '../../shared/types/task'
import { SYMPOSIUM_TOOL_OPTIONS, type AgentSymposium, type SymposiumContinueInput, type SymposiumDiscussionMemory, type SymposiumModelParticipant, type SymposiumStartInput, type SymposiumStreamEvent } from '../../shared/types/symposium'
import { controlForegroundGoal } from './task'

export interface ChatServices {
  toolRegistry: ToolRegistry
  providerRegistry: ProviderRegistry
  fileService: FileService
  terminalService: TerminalService
}

// Each conversation owns its runner. A model connection may be shared, but the
// prompt history, cancellation handle, and lifecycle must stay conversation-scoped.
const activeRunners = new Map<string, AgentRunner>()
// `run_task` creates a nested runner under the active chat runner. Keep its
// handle separately so cancellation and replacement cannot leave it orphaned.
const activeTaskRunners = new Map<string, AgentRunner>()
// Auto conversations can launch a Goal as an internal tool. Keep those planners
// separately from the visible Goal screen so they remain cancellable after the
// chat turn that started them has completed.
const activeBackgroundGoalPlanners = new Map<string, GoalPlanner>()
const activeSymposiumRunners = new Map<string, Set<AgentRunner>>()
const activeSymposiumAborters = new Map<string, () => void>()
const MAX_PERSISTED_TOOL_RESULT_CHARS = 12_000
const INTERNAL_TASK_TIMEOUT_MS = 3 * 60 * 1000

function compactToolResult(result: string): string {
  if (result.length <= MAX_PERSISTED_TOOL_RESULT_CHARS) return result
  return `${result.slice(0, MAX_PERSISTED_TOOL_RESULT_CHARS)}\n\n[Tool output truncated for conversation storage: ${result.length} characters total]`
}

function applyGoalProgress(current: GoalProgress | null, event: GoalEvent, conversationId: string): GoalProgress | null {
  switch (event.type) {
    case 'goal_started':
      return current || { goal: event.goal, steps: [], currentStepIndex: 0, totalSteps: 0, status: 'in_progress', startedAt: Date.now(), conversationId }
    case 'plan_created':
      return current ? { ...current, steps: event.steps, totalSteps: event.steps.length } : current
    case 'step_started':
      return current ? { ...current, currentStepIndex: event.stepIndex, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, status: 'in_progress', startedAt: Date.now() } : step) } : current
    case 'step_tool_call':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, toolCalls: [...(step.toolCalls || []), event.toolCall] } : step) } : current
    case 'step_tool_result':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, toolCalls: (step.toolCalls || []).map((toolCall) => toolCall.id === event.toolCallId ? { ...toolCall, result: event.result, isError: event.isError } : toolCall) } : step) } : current
    case 'step_completed':
    case 'step_failed':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, status: event.type === 'step_completed' ? 'completed' : 'failed', result: event.type === 'step_completed' ? event.result : event.error, completedAt: Date.now() } : step) } : current
    case 'plan_adjusted':
      return current ? { ...current, steps: [...current.steps.filter((step) => step.status === 'completed' || step.status === 'failed'), ...event.steps], totalSteps: current.steps.filter((step) => step.status === 'completed' || step.status === 'failed').length + event.steps.length } : current
    case 'summary':
      return current ? { ...current, summary: event.content } : current
    case 'done':
      return { ...event.progress, conversationId }
    default:
      return current
  }
}
const MAX_REFERENCE_IMAGES = 4
const MAX_REFERENCE_IMAGE_BYTES = 12 * 1024 * 1024
const IMAGE_MEDIA_TYPES = new Set<ChatImageAttachment['mediaType']>(['image/jpeg', 'image/png', 'image/webp'])

function symposiumTranscript(messages: ChatMessage[]): string {
  const visibleMessages = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-24)
    .map((message) => `${message.role === 'user' ? 'User' : message.agentName || 'Participant'}: ${message.content}`)
    .join('\n\n')
  return visibleMessages || '(The discussion has just started.)'
}

function getSymposiumHandle(participant: SymposiumModelParticipant): string {
  return participant.handle || participant.modelName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || participant.id
}

function mentionedSymposiumParticipants(content: string, participants: SymposiumModelParticipant[]): SymposiumModelParticipant[] {
  const normalized = content.toLowerCase()
  return participants.filter((participant) => normalized.includes(`@${getSymposiumHandle(participant).toLowerCase()}`))
}

function toolsForSymposiumParticipant(participant: SymposiumModelParticipant, legacyTools: string[], availableToolIds: Set<string>): string[] {
  return (participant.tools ?? legacyTools).filter((tool): tool is string => typeof tool === 'string' && availableToolIds.has(tool))
}

function symposiumMemoryBlock(memory: SymposiumDiscussionMemory | undefined): string {
  if (!memory) return 'No durable discussion brief has been saved yet.'
  const lines = [
    `Objective: ${memory.objective || '(not set)'}`,
    `Agreements: ${memory.agreements.length ? memory.agreements.map((item) => `- ${item}`).join('\n') : '(none)'}`,
    `Open questions: ${memory.openQuestions.length ? memory.openQuestions.map((item) => `- ${item}`).join('\n') : '(none)'}`,
    `Action items: ${memory.actionItems.length ? memory.actionItems.map((item) => `- ${item}`).join('\n') : '(none)'}`,
  ]
  return lines.join('\n')
}

async function runAgentSymposium(
  services: ChatServices,
  input: SymposiumStartInput | SymposiumContinueInput,
  win: BrowserWindow,
): Promise<void> {
  const conversation = await getStorage().conversations.getConversation(input.conversationId)
  if (!conversation) throw new Error('The Symposium conversation no longer exists.')

  const isStarting = 'participants' in input
  const existing = conversation.symposium
  const topic = isStarting ? input.topic.trim() : existing?.topic
  const userContribution = isStarting ? input.topic.trim() : input.content.trim()
  const availableSymposiumToolIds = new Set(SYMPOSIUM_TOOL_OPTIONS.map((tool) => tool.id))
  const selectedSymposiumTools = ((isStarting ? input.tools : existing?.tools) || [])
    .filter((tool): tool is string => typeof tool === 'string' && availableSymposiumToolIds.has(tool))
  if (!topic || !userContribution) throw new Error('A Symposium needs a discussion topic or contribution.')

  const agents = await getStorage().agents.listAgents()
  // Conversations created before model seats are preserved. They keep their
  // original agents, while every newly created Symposium binds its own model.
  const legacyParticipantIds = existing?.participantIds || []
  const legacyParticipants = legacyParticipantIds
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
  activeSymposiumAborters.set(input.conversationId, () => {
    cancelled = true
    activeSymposiumRunners.get(input.conversationId)?.forEach((runner) => runner.abort())
  })

  const buildSymposium = (status: AgentSymposium['status'], error?: string): AgentSymposium => ({
    topic,
    participants: uniqueParticipants,
    tools: selectedSymposiumTools,
    memory: initialMemory,
    status,
    startedAt,
    lastActivityAt: Date.now(),
    responseCycles: cycle,
    ...(error ? { error } : {}),
  })
  const persistSymposium = async (status: AgentSymposium['status'], error?: string): Promise<void> => {
    const latest = await getStorage().conversations.getConversation(input.conversationId)
    const latestSymposium = latest?.symposium
    const next = {
      ...buildSymposium(status, error),
      memory: latestSymposium?.memory || initialMemory,
    }
    await getStorage().conversations.updateConversation(input.conversationId, { symposium: next })
  }

  await persistSymposium('running')
  emit({ type: 'started', cycle, participantCount: uniqueParticipants.length })

  try {
    const priorMessages = await getStorage().conversations.getMessages(input.conversationId)
    const duplicateOpening = isStarting && priorMessages.some((message) => message.role === 'user' && message.content === userContribution)
    if (!duplicateOpening) {
      await getStorage().conversations.addMessage(input.conversationId, {
        id: uuidv4(),
        role: 'user',
        content: userContribution,
        timestamp: Date.now(),
      })
      if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, input.conversationId)
    }

    const access = await getConversationAccess(conversation)
    const workspacePath = conversation.workspacePath || (access.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath'))
    const runnerSet = new Set<AgentRunner>()
    activeSymposiumRunners.set(input.conversationId, runnerSet)
    const runParticipant = async (participant: SymposiumModelParticipant): Promise<{ participant: SymposiumModelParticipant; content: string; error?: string }> => {
      const provider = services.providerRegistry.get(participant.providerId)
      if (!provider) throw new Error(`${participant.providerName} / ${participant.modelName} is not an enabled model connection.`)
      const seatName = `${participant.providerName} / ${participant.modelName}`
      const seatTools = toolsForSymposiumParticipant(participant, selectedSymposiumTools, availableSymposiumToolIds)
      const runnerTools = seatTools
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
        // Symposium participants can need several research and verification
        // passes before replying. Keep tool-free seats single-pass, while
        // allowing tool-enabled seats enough room to complete real work.
        maxIterations: runnerTools.length ? 12 : 1,
        temperature: 0.55,
        isBuiltIn: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      emit({ type: 'speaker_started', agentId: participant.id, agentName: seatName, cycle, participantCount: uniqueParticipants.length })
      const history = sanitizeToolHistory(await getStorage().conversations.getMessages(input.conversationId))
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
        toolRegistry: services.toolRegistry,
        contextManager: new ContextManager(),
        workspacePath,
        fileAccessGrants: access.fileAccessGrants,
        fullFilesystemAccess: access.fullFilesystemAccess,
        fileService: services.fileService,
        terminalService: services.terminalService,
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
      await getStorage().conversations.addMessage(input.conversationId, {
        id: uuidv4(),
        role: 'assistant',
        content: content.trim() || fallbackContent,
        agentId: participant.id,
        agentName: seatName,
        timestamp: Date.now(),
      })
      if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, input.conversationId)
      emit({ type: 'speaker_completed', agentId: participant.id, agentName: seatName, cycle, participantCount: uniqueParticipants.length })
      return { participant, content, error }
    }

    const initialTargets = mentionedSymposiumParticipants(userContribution, uniqueParticipants)
    let pendingParticipants = initialTargets.length ? initialTargets : uniqueParticipants
    const alreadyResponded = new Set<string>()
    // A mention starts the next wave. Writer seats run serially so later seats
    // can inspect the newest workspace state before modifying the same file.
    while (pendingParticipants.length && !cancelled) {
      const batch = pendingParticipants.filter((participant) => !alreadyResponded.has(participant.id))
      if (!batch.length) break
      batch.forEach((participant) => alreadyResponded.add(participant.id))
      const results = batch.some((participant) => toolsForSymposiumParticipant(participant, selectedSymposiumTools, availableSymposiumToolIds).includes('write_file'))
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
    activeSymposiumRunners.delete(input.conversationId)
    activeSymposiumAborters.delete(input.conversationId)
  }
}

function loadReferenceImages(images: ChatImageAttachment[] | undefined, strict: boolean): ChatImageAttachment[] | undefined {
  if (!images?.length) return undefined
  if (images.length > MAX_REFERENCE_IMAGES) throw new Error(`Attach at most ${MAX_REFERENCE_IMAGES} reference images at once.`)

  const loaded: ChatImageAttachment[] = []
  for (const image of images) {
    try {
      if (!IMAGE_MEDIA_TYPES.has(image.mediaType)) throw new Error(`${image.name} is not a supported image type.`)
      const stats = fs.statSync(image.path)
      if (!stats.isFile()) throw new Error(`${image.name} is not a file.`)
      if (stats.size > MAX_REFERENCE_IMAGE_BYTES) throw new Error(`${image.name} exceeds the 12 MB limit.`)
      const dataUrl = `data:${image.mediaType};base64,${fs.readFileSync(image.path).toString('base64')}`
      loaded.push({ ...image, size: stats.size, dataUrl })
    } catch (error) {
      if (strict) throw error
    }
  }
  return loaded.length ? loaded : undefined
}

function persistableImages(images: ChatImageAttachment[] | undefined): ChatImageAttachment[] | undefined {
  return images?.map(({ dataUrl: _dataUrl, ...image }) => image)
}

async function runInternalTeamDelegation(
  services: ChatServices,
  conversation: Conversation,
  historyMessages: ChatMessage[],
  goal: string,
  win: BrowserWindow
): Promise<string> {
  const agents = await getStorage().agents.listAgents()
  const leader = agents.find((agent: AgentConfig) => agent.role === 'leader')
  if (!leader) throw new Error('No Team Leader agent is configured.')

  const workers = agents.filter((agent: AgentConfig) =>
    ['researcher', 'coder', 'reviewer', 'tester'].includes(agent.role)
  )
  const connectionCandidates = [
    ...(leader.modelCandidates || []),
    { providerId: leader.providerId, model: leader.model },
    ...(leader.isBuiltIn ? [{ providerId: getStorage().config.get('activeProviderId'), model: getStorage().config.getActiveModel() }] : []),
  ]
  if (!connectionCandidates.some((candidate) => services.providerRegistry.get(candidate.providerId))) {
    throw new Error('The Team Leader has no available model connection. Configure its model access first.')
  }

  const access = await getConversationAccess(conversation)
  const workerContexts = new Map<string, string>()
  const createWorkerConversation = async (subtask: import('../../shared/types/task').SubTask, worker: AgentConfig): Promise<string> => {
    const child = await getStorage().conversations.createConversation({
      title: `${worker.name}: ${subtask.title}`,
      agentId: worker.id,
      mode: 'expert',
      workspaceId: conversation.workspaceId,
      accessScope: conversation.accessScope,
      permissionLevel: conversation.permissionLevel,
      fileAccessGrants: conversation.fileAccessGrants,
      workspacePath: conversation.workspacePath,
      parentConversationId: conversation.id,
      teamTaskId: subtask.id,
    })
    workerContexts.set(subtask.id, child.id)
    await getStorage().conversations.addMessage(child.id, {
      id: uuidv4(), conversationId: child.id, role: 'user',
      content: `Team assignment\n\nTask: ${subtask.title}\n\nResponsibility: ${subtask.description}\n\nRole: ${subtask.assignedRole || worker.role}\nModel: ${worker.providerId} / ${worker.model}\n\nThis is an isolated worker context. Report concrete findings and completed work back to the team leader.`,
      timestamp: Date.now(),
    })
    if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, child.id)
    return child.id
  }
  const persistWorkerEvent = async (
    subtask: import('../../shared/types/task').SubTask,
    worker: AgentConfig,
    agentEvent: AgentEvent,
  ): Promise<void> => {
    if (agentEvent.type === 'text' || agentEvent.type === 'thinking') return
    const childId = subtask.agentConversationId || workerContexts.get(subtask.id)
    if (!childId) return
    let content = ''
    let role: ChatMessage['role'] = 'assistant'
    if (agentEvent.type === 'tool_call' && agentEvent.toolCall) content = `Calling tool: ${agentEvent.toolCall.name}`
    if (agentEvent.type === 'tool_result' && agentEvent.toolResult) {
      role = 'tool'
      const result = agentEvent.toolResult.result
      content = `${agentEvent.toolResult.name}: ${result.length > 8000 ? `${result.slice(0, 8000)}\n\n[Output truncated in worker history]` : result}`
    }
    if (agentEvent.type === 'done' && agentEvent.content) content = agentEvent.content
    if (agentEvent.type === 'error' && agentEvent.error) content = `Error: ${agentEvent.error}`
    if (!content) return
    await getStorage().conversations.addMessage(childId, {
      id: uuidv4(), conversationId: childId, role, content, agentId: worker.id, agentName: worker.name, timestamp: Date.now(),
    })
    if ((agentEvent.type === 'done' || agentEvent.type === 'error') && !win.isDestroyed()) {
      win.webContents.send(IPC.CONVERSATION_CHANGED, childId)
    }
  }
  const orchestrator = new TeamOrchestrator({
    conversationId: conversation.id,
    leader,
    workers,
    providerForAgent: (agent) => services.providerRegistry.get(agent.providerId),
    fallbackModel: { providerId: getStorage().config.get('activeProviderId'), model: getStorage().config.getActiveModel() },
    toolRegistry: services.toolRegistry,
    contextManager: new ContextManager(),
    workspacePath: conversation.workspacePath || (access.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath')),
    fileAccessGrants: access.fileAccessGrants,
    fullFilesystemAccess: access.fullFilesystemAccess,
    fileService: services.fileService,
    terminalService: services.terminalService,
    createWorkerConversation,
    onWorkerEvent: persistWorkerEvent,
  })

  let summary = ''
  for await (const event of orchestrator.run({ goal, messages: historyMessages })) {
    if (!win.isDestroyed()) win.webContents.send(IPC.TASK_STREAM, { ...event, conversationId: conversation.id })
    if (event.type === 'summary') summary = event.summary || ''
    if (event.type === 'error') throw new Error(event.error || 'Team orchestration failed.')
  }
  return summary || 'The specialist team completed the delegated work without a separate summary.'
}

function toChatStreamEvent(event: AgentEvent): ChatStreamEvent {
  switch (event.type) {
    case 'text':
      return { type: 'text_delta', content: event.content }
    case 'thinking':
      return { type: 'thinking', content: event.content }
    case 'tool_call':
      return { type: 'tool_call_start', toolCall: event.toolCall }
    case 'tool_result':
      return {
        type: 'tool_result',
        toolCallId: event.toolResult?.toolCallId,
        toolResult: event.toolResult?.result,
        isError: event.toolResult?.isError,
      }
    case 'error':
      return { type: 'error', error: event.error }
    case 'done':
      return { type: 'done', content: event.content }
  }
}

async function getConversationAccess(conversation?: Conversation): Promise<{ fileAccessGrants: import('../../shared/types/file-access').FileAccessGrant[]; fullFilesystemAccess: boolean }> {
  if (conversation?.permissionLevel) {
    if (conversation.permissionLevel === 'full-access') {
      return { fileAccessGrants: [], fullFilesystemAccess: true }
    }
    if (conversation.permissionLevel === 'granted-folders') {
      return { fileAccessGrants: conversation.fileAccessGrants || [], fullFilesystemAccess: false }
    }
    return { fileAccessGrants: [], fullFilesystemAccess: false }
  }

  // Preserve behavior for conversations created before per-conversation permissions.
  if (conversation?.accessScope === 'full') {
    return { fileAccessGrants: [], fullFilesystemAccess: true }
  }
  if (conversation?.workspacePath) {
    return { fileAccessGrants: [], fullFilesystemAccess: false }
  }
  return {
    fileAccessGrants: getStorage().config.get('fileAccessGrants'),
    fullFilesystemAccess: false,
  }
}

export function registerConversationHandlers(services?: ChatServices): void {
  // ─── Conversation CRUD ──────────────────────────────────────────────────────

  ipcMain.handle(IPC.CONVERSATION_LIST, async (): Promise<Conversation[]> => {
    return getStorage().conversations.listConversations()
  })

  ipcMain.handle(
    IPC.CONVERSATION_CREATE,
    async (
      _event,
      data: { title?: string; agentId?: string; mode?: 'normal' | 'expert' | 'goal'; workspaceId?: string; workspacePath?: string; accessScope?: Conversation['accessScope']; permissionLevel?: Conversation['permissionLevel']; fileAccessGrants?: Conversation['fileAccessGrants']; symposium?: Conversation['symposium'] }
    ): Promise<Conversation> => {
      const workspace = data.workspaceId ? await getStorage().workspaces.get(data.workspaceId) : null
      const conversation = await getStorage().conversations.createConversation({
        title: data.title || 'New Conversation',
        agentId: data.agentId || '',
        mode: data.mode || 'normal',
        workspaceId: workspace?.id,
        accessScope: workspace ? 'workspace' : data.accessScope,
        permissionLevel: data.permissionLevel || (workspace ? 'workspace' : 'full-access'),
        fileAccessGrants: data.fileAccessGrants || [],
        symposium: data.symposium,
        workspacePath: data.workspacePath ?? workspace?.path ?? getStorage().config.get('workspacePath'),
      })
      void recordActivity({
        category: 'conversation',
        action: 'conversation.created',
        status: 'success',
        summary: `Created conversation: ${conversation.title}`,
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
      }, BrowserWindow.fromWebContents(_event.sender))
      return conversation
    }
  )

  ipcMain.handle(IPC.CONVERSATION_DELETE, async (event, id: string): Promise<void> => {
    const conversation = await getStorage().conversations.getConversation(id)
    await getStorage().conversations.deleteConversation(id)
    void recordActivity({
      category: 'conversation',
      action: 'conversation.deleted',
      status: 'info',
      summary: `Deleted conversation: ${conversation?.title || 'Untitled'}`,
      workspaceId: conversation?.workspaceId,
    }, BrowserWindow.fromWebContents(event.sender))
  })

  ipcMain.handle(
    IPC.CONVERSATION_LOAD,
    async (
      _event,
      id: string
    ): Promise<{ conversation: Conversation; messages: ChatMessage[] }> => {
      const store = getStorage().conversations
      const conversation = await store.getConversation(id)
      if (!conversation) {
        throw new Error(`Conversation ${id} not found`)
      }
      const messages = await store.getMessages(id)
      return { conversation, messages }
    }
  )

  ipcMain.handle(
    IPC.CONVERSATION_UPDATE,
    async (
      event,
      id: string,
      data: Partial<Pick<Conversation, 'title' | 'agentId' | 'archived' | 'permissionLevel' | 'fileAccessGrants' | 'multiDimensionalIndexEnabled' | 'symposium'>>
    ): Promise<void> => {
      const conversation = await getStorage().conversations.getConversation(id)
      await getStorage().conversations.updateConversation(id, data)

      if (data.archived !== undefined) {
        void recordActivity({
          category: 'conversation',
          action: data.archived ? 'conversation.archived' : 'conversation.restored',
          status: 'success',
          summary: `${data.archived ? 'Archived' : 'Restored'} conversation: ${conversation?.title || 'Untitled'}`,
          conversationId: id,
          workspaceId: conversation?.workspaceId,
        }, BrowserWindow.fromWebContents(event.sender))
      }
      if (data.permissionLevel) {
        void recordActivity({
          category: 'permission',
          action: 'permission.updated',
          status: 'info',
          summary: `Set access to ${data.permissionLevel.replace('-', ' ')}.`,
          conversationId: id,
          workspaceId: conversation?.workspaceId,
        }, BrowserWindow.fromWebContents(event.sender))
      }
      if (data.agentId) {
        void recordActivity({
          category: 'conversation',
          action: 'conversation.agent_updated',
          status: 'info',
          summary: 'Updated the conversation agent.',
          conversationId: id,
          workspaceId: conversation?.workspaceId,
        }, BrowserWindow.fromWebContents(event.sender))
      }
    }
  )

  // ─── Chat: send (fire-and-forget; events streamed via CHAT_STREAM) ──────────

  ipcMain.on(
    IPC.CHAT_SEND,
    async (event, payload: { conversationId: string; message: string; agentId?: string; images?: ChatImageAttachment[] }) => {
      const { conversationId, message } = payload
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      let runner: AgentRunner | null = null

      const send = (agentEvent: AgentEvent): void => {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.CHAT_STREAM, { ...toChatStreamEvent(agentEvent), conversationId })
        }
      }

      try {
        if (!services) {
          send({ type: 'error', error: 'Chat services not initialized' })
          send({ type: 'done', content: '' })
          return
        }

        // 1. Load conversation + message history
        const convStore = getStorage().conversations
        const conversation = await convStore.getConversation(conversationId)
        if (!conversation) {
          send({ type: 'error', error: `Conversation ${conversationId} not found` })
          send({ type: 'done', content: '' })
          return
        }
        const historyMessages = sanitizeToolHistory(await convStore.getMessages(conversationId)).map((item) => ({
          ...item,
          images: loadReferenceImages(item.images, false),
        }))

        // 2. Load agent config — prefer payload agentId, fallback to conversation.agentId, then first available
        let agentId = payload.agentId || conversation.agentId
        let agentConfig = agentId ? await getStorage().agents.getAgent(agentId) : null
        if (!agentConfig) {
          // Fallback to first available agent
          const allAgents = await getStorage().agents.listAgents()
          agentConfig = allAgents.length > 0 ? allAgents[0] : null
        }
        if (!agentConfig) {
          send({ type: 'error', error: 'No agent available. Please configure an agent first.' })
          send({ type: 'done', content: '' })
          return
        }

        // 3. Built-in agents inherit the active Settings provider and model. Custom agents
        // retain their individual configuration as an explicit advanced override.
        const activeProviderId = getStorage().config.get('activeProviderId')
        const activeModel = getStorage().config.getActiveModel()
        const effectiveAgentConfig = agentConfig.isBuiltIn
          ? { ...agentConfig, providerId: activeProviderId, model: activeModel }
          : agentConfig

        void recordActivity({
          category: 'agent',
          action: 'agent.started',
          status: 'info',
          summary: `${effectiveAgentConfig.name} started a response.`,
          conversationId,
          workspaceId: conversation.workspaceId,
        }, win)

        const provider = services.providerRegistry.get(effectiveAgentConfig.providerId)
        if (!provider) {
          send({ type: 'error', error: `Provider ${effectiveAgentConfig.providerId} not available` })
          send({ type: 'done', content: '' })
          return
        }

        // 4. Save user message to storage immediately
        const userMessageId = uuidv4()
        const referenceImages = loadReferenceImages(payload.images, true)
        const userChatMessage: ChatMessage = {
          id: userMessageId,
          conversationId,
          role: 'user',
          content: message,
          images: referenceImages,
          timestamp: Date.now(),
        }
        await convStore.addMessage(conversationId, { ...userChatMessage, images: persistableImages(referenceImages) })

        // 5. Create AgentRunner
        const workspaceAccess = await getConversationAccess(conversation)
        const storedAutomation = getStorage().config.get('automation')
        const automation: AutomationConfig = {
          ...DEFAULT_AUTOMATION_CONFIG,
          ...storedAutomation,
          team: { ...DEFAULT_AUTOMATION_CONFIG.team, ...storedAutomation?.team },
          task: { ...DEFAULT_AUTOMATION_CONFIG.task, ...storedAutomation?.task },
          goal: { ...DEFAULT_AUTOMATION_CONFIG.goal, ...storedAutomation?.goal },
          plan: { ...DEFAULT_AUTOMATION_CONFIG.plan, ...storedAutomation?.plan },
          spec: { ...DEFAULT_AUTOMATION_CONFIG.spec, ...storedAutomation?.spec },
        }
        const runnerWorkspacePath = conversation.workspacePath || (workspaceAccess.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath'))
        const runTask = automation.task.enabled && automation.task.autoInvoke
          ? async (task: string): Promise<string> => {
              // A new nested task supersedes an older one for this conversation.
              activeTaskRunners.get(conversationId)?.abort()
              const worker = new AgentRunner({
                conversationId,
                agentConfig: effectiveAgentConfig,
                provider,
                toolRegistry: services.toolRegistry,
                contextManager: new ContextManager(),
                workspacePath: runnerWorkspacePath,
                fileAccessGrants: workspaceAccess.fileAccessGrants,
                fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
                fileService: services.fileService,
                terminalService: services.terminalService,
              })
              let output = ''
              const taskMessage: ChatMessage = {
                id: uuidv4(), conversationId, role: 'user', content: `Complete this bounded internal task and report the concrete result:\n${task}`, timestamp: Date.now(),
              }
              activeTaskRunners.set(conversationId, worker)

              let timeout: ReturnType<typeof setTimeout> | undefined
              try {
                const execution = (async () => {
                  for await (const event of worker.run({ messages: [], newMessage: taskMessage })) {
                    if (event.type === 'text' && event.content) output += event.content
                    if (event.type === 'tool_result' && event.toolResult) output += `\n[${event.toolResult.name}] ${event.toolResult.result}`
                    if (event.type === 'error') throw new Error(event.error)
                  }
                })()

                await Promise.race([
                  execution,
                  new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => {
                      worker.abort()
                      reject(new Error('run_task timed out after 3 minutes and was stopped. Use Goal or the task center for longer, recoverable work.'))
                    }, INTERNAL_TASK_TIMEOUT_MS)
                  }),
                ])
              } finally {
                if (timeout) clearTimeout(timeout)
                if (activeTaskRunners.get(conversationId) === worker) {
                  activeTaskRunners.delete(conversationId)
                }
              }
              return output.trim() || 'Task execution completed.'
            }
          : undefined
        const runGoal = automation.goal.enabled && automation.goal.autoInvoke
          ? async (goal: string, resumeProgress?: GoalProgress | null): Promise<string> => {
              // A Goal can outlive the response that requested it. Running it in
              // the tool-call stack caused provider request limits to terminate
              // otherwise healthy long jobs, so launch it independently and
              // retain progress in the task store instead.
              activeBackgroundGoalPlanners.get(conversationId)?.abort()
              const previousSnapshot = resumeProgress ? await getStorage().taskRuns.get(conversationId) : null
              const configuredTimeoutMinutes = automation.goal.timeoutMinutes === 10
                ? DEFAULT_AUTOMATION_CONFIG.goal.timeoutMinutes
                : automation.goal.timeoutMinutes
              const timeout = configuredTimeoutMinutes * 60 * 1000
              const planner = new GoalPlanner({
                conversationId,
                agentConfig: effectiveAgentConfig,
                provider,
                toolRegistry: services.toolRegistry,
                contextManager: new ContextManager(),
                workspacePath: runnerWorkspacePath,
                fileAccessGrants: workspaceAccess.fileAccessGrants,
                fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
                fileService: services.fileService,
                terminalService: services.terminalService,
                maxSteps: automation.goal.maxSteps,
                timeout,
              })
              activeBackgroundGoalPlanners.set(conversationId, planner)

              // Persist the run before the first model/planner event. This
              // keeps the task center and a remounted chat in agreement about
              // a Goal that is still starting up.
              await getStorage().taskRuns.save({
                conversationId,
                kind: 'goal',
                status: 'running',
                goal,
                agentId: effectiveAgentConfig.id,
                progress: resumeProgress
                  ? { ...resumeProgress, goal, status: 'in_progress', completedAt: undefined, conversationId }
                  : {
                      goal,
                      steps: [],
                      currentStepIndex: 0,
                      totalSteps: 0,
                      status: 'in_progress',
                      startedAt: Date.now(),
                      conversationId,
                    },
                checkpoints: previousSnapshot?.checkpoints || [],
                error: undefined,
              })

              void (async () => {
                let progress: GoalProgress | null = resumeProgress || null
                try {
                  for await (const goalEvent of planner.run({ goal, maxSteps: automation.goal.maxSteps, timeout, autoAdjust: true }, resumeProgress || undefined)) {
                    progress = applyGoalProgress(progress, goalEvent, conversationId)
                    await getStorage().taskRuns.save({
                      conversationId,
                      kind: 'goal',
                      status: goalEvent.type === 'done'
                        ? (goalEvent.progress.status === 'completed' ? 'completed' : goalEvent.progress.status === 'cancelled' ? 'cancelled' : 'failed')
                        : goalEvent.type === 'error' ? 'failed' : 'running',
                      progress: progress || undefined,
                      summary: goalEvent.type === 'summary' ? goalEvent.content : progress?.summary,
                      error: goalEvent.type === 'error' ? goalEvent.error : undefined,
                    })
                    if (!win.isDestroyed()) {
                      win.webContents.send(IPC.TASK_GOAL_STREAM, { ...goalEvent, conversationId })
                    }
                  }
                } catch (error: any) {
                  const message = error?.message ?? String(error)
                  await getStorage().taskRuns.save({ conversationId, kind: 'goal', status: 'failed', progress: progress || undefined, error: message })
                  if (!win.isDestroyed()) win.webContents.send(IPC.TASK_GOAL_STREAM, { type: 'error', error: message, conversationId })
                } finally {
                  if (activeBackgroundGoalPlanners.get(conversationId) === planner) {
                    activeBackgroundGoalPlanners.delete(conversationId)
                  }
                }
              })()

              return 'Goal accepted and running in the background. Its execution card and task-center status are authoritative; do not treat this acknowledgement as the final result.'
            }
          : undefined
        const manageGoal = automation.goal.enabled
          ? async (action: 'status' | 'pause' | 'resume' | 'cancel'): Promise<string> => {
              const backgroundPlanner = activeBackgroundGoalPlanners.get(conversationId)
              const foreground = await controlForegroundGoal(conversationId, action)
              const snapshot = await getStorage().taskRuns.get(conversationId)

              if (action === 'status') {
                const status = foreground.status || snapshot?.status
                if (!status) return 'There is no Goal task for this conversation.'
                const completed = snapshot?.progress?.steps.filter((step) => step.status === 'completed').length || 0
                const total = snapshot?.progress?.steps.length || 0
                return `Goal status: ${status}. Progress: ${completed}/${total} steps completed.`
              }

              if (foreground.handled) return `Goal task ${action === 'cancel' ? 'was cancelled' : action === 'pause' ? 'was paused' : 'is running again'}.`

              if (action === 'pause' || action === 'cancel') {
                if (!backgroundPlanner) return 'There is no active Goal task to control in this conversation.'
                if (action === 'pause') {
                  backgroundPlanner.pause()
                  if (snapshot) await getStorage().taskRuns.save({ ...snapshot, status: 'paused' })
                  return 'Goal task was paused after its current operation.'
                }
                backgroundPlanner.abort()
                if (snapshot) await getStorage().taskRuns.save({ ...snapshot, status: 'cancelled' })
                return 'Goal task was cancelled.'
              }

              if (action === 'resume') {
                if (backgroundPlanner) {
                  backgroundPlanner.resume()
                  if (snapshot) await getStorage().taskRuns.save({ ...snapshot, status: 'running' })
                  return 'Goal task is running again.'
                }
                if (!snapshot || snapshot.kind !== 'goal' || !snapshot.goal) {
                  return 'There is no saved Goal task to continue in this conversation.'
                }
                if (snapshot.status === 'completed') return 'This Goal has already completed. Start a follow-up Goal for additional work.'
                if (!runGoal) return 'Goal execution is disabled for this agent.'
                await runGoal(snapshot.goal, snapshot.progress)
                return snapshot.progress?.steps.length
                  ? 'Goal task resumed from its saved checkpoint; completed steps will be skipped.'
                  : 'This older Goal has no saved plan, so it was restarted from the original request.'
              }

              return 'Goal control request was not recognized.'
            }
          : undefined
        const createExecutionPlan = automation.plan.enabled && automation.plan.autoInvoke
          ? async (goal: string): Promise<string> => {
              const messages: ChatMessageInput[] = [
                { role: 'system', content: 'Create a concise actionable execution plan. Include ordered steps, risks, verification, and stop conditions. Do not execute work.' },
                { role: 'user', content: `Goal: ${goal}\nWorkspace: ${runnerWorkspacePath || 'not restricted to a single workspace'}` },
              ]
              const response = await provider.chatComplete({ model: effectiveAgentConfig.model, messages, temperature: 0.2, maxTokens: 2048 })
              return response.content
            }
          : undefined
        const applySpecTemplate = automation.spec.enabled && automation.spec.autoInvoke
          ? async (templateId: string, parameters: Record<string, string>): Promise<string> => {
              const specService = new SpecService()
              specService.initialize()
              const template = specService.getTemplate(templateId)
              if (!template) throw new Error(`Spec template '${templateId}' was not found.`)
              return specService.instantiateTemplate(templateId, parameters)
            }
          : undefined
        runner = new AgentRunner({
          conversationId,
          agentConfig: effectiveAgentConfig,
          provider,
          toolRegistry: services.toolRegistry,
          contextManager: new ContextManager(),
          workspacePath: runnerWorkspacePath,
          fileAccessGrants: workspaceAccess.fileAccessGrants,
          fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
          fileService: services.fileService,
          terminalService: services.terminalService,
          delegateToTeam: automation.team.enabled && automation.team.autoInvoke ? (goal) => runInternalTeamDelegation(
            services,
            conversation,
            historyMessages,
            goal,
            win
          ) : undefined,
          runTask,
          runGoal,
          manageGoal,
          createExecutionPlan,
          applySpecTemplate,
        })
        // A second send in the same chat replaces the prior run; other chats
        // retain their own runners and continue independently.
        activeRunners.get(conversationId)?.abort()
        activeTaskRunners.get(conversationId)?.abort()
        activeTaskRunners.delete(conversationId)
        activeRunners.set(conversationId, runner)

        // 6. Execute the ReAct loop and stream events
        const allToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
        const allToolResults: Array<{ toolCallId: string; name: string; result: string; isError: boolean }> = []
        let assistantContent = ''
        let runError: string | null = null

        for await (const agentEvent of runner.run({ messages: historyMessages, newMessage: userChatMessage })) {
          // Accumulate content and tool info for persistence
          if (agentEvent.type === 'text' && agentEvent.content) {
            // Text events are streaming deltas. The final done event replaces
            // this accumulated draft with the canonical response content.
            assistantContent += agentEvent.content
          }
          if (agentEvent.type === 'tool_call' && agentEvent.toolCall) {
            allToolCalls.push(agentEvent.toolCall)
            void recordActivity({
              category: 'tool',
              action: 'tool.started',
              status: 'info',
              summary: `${effectiveAgentConfig.name} started ${agentEvent.toolCall.name}.`,
              conversationId,
              workspaceId: conversation.workspaceId,
            }, win)
          }
          if (agentEvent.type === 'tool_result' && agentEvent.toolResult) {
            allToolResults.push(agentEvent.toolResult)
            void recordActivity({
              category: 'tool',
              action: 'tool.completed',
              status: agentEvent.toolResult.isError ? 'error' : 'success',
              summary: `${agentEvent.toolResult.name} ${agentEvent.toolResult.isError ? 'failed' : 'completed'}.`,
              conversationId,
              workspaceId: conversation.workspaceId,
            }, win)
          }
          if (agentEvent.type === 'done' && agentEvent.content) {
            assistantContent = agentEvent.content
          }
          if (agentEvent.type === 'error') {
            runError = agentEvent.error || 'The model response failed.'
          }

          // Forward event to renderer
          send(agentEvent)
        }

        // 7. Save assistant response to storage
        const assistantMessageId = uuidv4()
        const toolCallsForMessage: ToolCall[] | undefined =
          allToolCalls.length > 0
            ? allToolCalls.map((tc) => {
                const result = allToolResults.find((r) => r.toolCallId === tc.id)
                return {
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                  result: result ? compactToolResult(result.result) : undefined,
                  isError: result?.isError,
                }
              })
            : undefined

        const assistantChatMessage: ChatMessage = {
          id: assistantMessageId,
          conversationId,
          role: 'assistant',
          content: runError && !assistantContent && allToolCalls.length === 0 ? `Error: ${runError}` : assistantContent,
          toolCalls: toolCallsForMessage,
          agentId: agentConfig.id,
          agentName: agentConfig.name,
          timestamp: Date.now(),
        }
        await convStore.addMessage(conversationId, assistantChatMessage)

        // Save individual tool messages for tool results
        for (const tr of allToolResults) {
          const toolMessage: ChatMessage = {
            id: uuidv4(),
            conversationId,
            role: 'tool',
            content: compactToolResult(tr.result),
            toolCallId: tr.toolCallId,
            agentId: agentConfig.id,
            agentName: agentConfig.name,
            timestamp: Date.now(),
          }
          await convStore.addMessage(conversationId, toolMessage)
        }
        win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
        void recordActivity({
          category: 'agent',
          action: runError ? 'agent.failed' : 'agent.completed',
          status: runError ? 'error' : 'success',
          summary: runError || `${effectiveAgentConfig.name} completed the response.`,
          conversationId,
          workspaceId: conversation.workspaceId,
        }, win)
      } catch (err: any) {
        void recordActivity({
          category: 'agent',
          action: 'agent.failed',
          status: 'error',
          summary: 'Agent response failed.',
          conversationId,
        }, win)
        send({ type: 'error', error: err?.message ?? String(err) })
        send({ type: 'done', content: '' })
      } finally {
        // Do not remove a newer run started for the same conversation.
        if (runner && activeRunners.get(conversationId) === runner) {
          activeRunners.delete(conversationId)
        }
      }
    }
  )

  // ─── Chat: abort ────────────────────────────────────────────────────────────

  ipcMain.on(IPC.CHAT_ABORT, (_event, conversationId?: string) => {
    if (conversationId) {
      activeRunners.get(conversationId)?.abort()
      activeTaskRunners.get(conversationId)?.abort()
      activeBackgroundGoalPlanners.get(conversationId)?.abort()
      activeSymposiumAborters.get(conversationId)?.()
      activeTaskRunners.delete(conversationId)
    }
  })

  ipcMain.on(IPC.SYMPOSIUM_START, (event, input: SymposiumStartInput) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!services || !win) return
    activeSymposiumAborters.get(input.conversationId)?.()
    void runAgentSymposium(services, input, win)
  })

  ipcMain.on(IPC.SYMPOSIUM_CONTINUE, (event, input: SymposiumContinueInput) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!services || !win) return
    if (activeSymposiumAborters.has(input.conversationId)) return
    void runAgentSymposium(services, input, win)
  })

  ipcMain.on(IPC.SYMPOSIUM_ABORT, (_event, conversationId: string) => {
    activeSymposiumAborters.get(conversationId)?.()
  })

  ipcMain.on(IPC.TASK_GOAL_ABORT, (_event, conversationId: string) => {
    activeBackgroundGoalPlanners.get(conversationId)?.abort()
  })
}
