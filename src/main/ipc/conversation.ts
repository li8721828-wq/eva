import fs from 'fs'
import path from 'path'
import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { Conversation, ChatDocumentAttachment, ChatImageAttachment, ChatMessage, ChatMessageReference, ChatUsage, ToolCall, ChatStreamEvent, ExecutionTimelineEntry, ExecutionTraceEntry, ProgressUpdate, ProgressUpdateKind } from '../../shared/types/conversation'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent'
import type { ToolRegistry, FileService, TerminalService } from '../tools'
import type { ProviderRegistry } from '../providers'
import { AgentRunner } from '../agent-engine/agent-runner'
import { ContextManager } from '../agent-engine/context'
import { TeamOrchestrator } from '../agent-engine/team-orchestrator'
import { GoalPlanner } from '../agent-engine/goal-planner'
import type { GoalEvent } from '../agent-engine/goal-planner'
import { getStorage } from '../storage'
import { getAgentOsScheduler } from '../services/agent-os-scheduler'
import { v4 as uuidv4 } from 'uuid'
import { recordActivity } from '../services/activity-log'
import { sanitizeToolHistory } from '../agent-engine/tool-history'
import { SpecService } from '../services/spec-service'
import type { AutomationConfig } from '../../shared/types/automation'
import { DEFAULT_AUTOMATION_CONFIG } from '../../shared/types/automation'
import type { ChatMessageInput } from '../../shared/types/provider'
import type { GoalProgress } from '../../shared/types/task'
import { prepareGoalStepConversation, persistGoalStepEvent } from '../services/goal-step-conversation'
import { resolveEffectiveAgentConfig } from '../services/effective-agent-config'
import { SYMPOSIUM_TOOL_OPTIONS, type AgentSymposium, type SymposiumContinueInput, type SymposiumDiscussionMemory, type SymposiumModelParticipant, type SymposiumStartInput, type SymposiumStreamEvent } from '../../shared/types/symposium'
import { controlForegroundGoal } from './task'
import { registerBackgroundGoalController, type BackgroundGoalAction, type BackgroundGoalControlResult } from '../services/background-goal-control'
import { generateConversationTitle, refreshLegacyConversationTitles } from '../services/conversation-title-service'
import { buildDocumentAttachmentContext } from '../services/document-attachment-service'
import { ModelRouter } from '../services/model-router'
import type { ModelPoolEntry } from '../../shared/types/model-pool'
import type { ActivePlan } from '../../shared/types/active-plan'
import { hydrateUsagePricing } from '../services/usage-pricing-service'
import { ensureProviderPricing } from '../services/supplier-pricing-service'
import { formatProviderRequestFailure } from '../services/provider-request-diagnostics'

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
let legacyTitleRefreshTimer: ReturnType<typeof setTimeout> | undefined

function scheduleLegacyTitleRefresh(services: ChatServices): void {
  if (legacyTitleRefreshTimer) return

  const runWhenIdle = (): void => {
    if (activeRunners.size > 0 || activeTaskRunners.size > 0) {
      legacyTitleRefreshTimer = setTimeout(runWhenIdle, 5_000)
      return
    }

    legacyTitleRefreshTimer = undefined
    const provider = services.providerRegistry.get(getStorage().config.get('activeProviderId'))
    const model = getStorage().config.getActiveModel()
    if (!provider || !model) return

    void refreshLegacyConversationTitles({
      provider,
      model,
      notify: (conversationId) => BrowserWindow.getAllWindows().forEach((window) => {
        if (!window.isDestroyed()) window.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
      }),
    })
  }

  // Let the renderer settle first. A new foreground request takes priority and
  // causes this background migration to wait for an idle period.
  legacyTitleRefreshTimer = setTimeout(runWhenIdle, 5_000)
}
// Auto conversations can launch a Goal as an internal tool. Keep those planners
// separately from the visible Goal screen so they remain cancellable after the
// chat turn that started them has completed.
const activeBackgroundGoalPlanners = new Map<string, GoalPlanner>()
const activeDelegatedTeamOrchestrators = new Map<string, TeamOrchestrator>()
const activeSymposiumRunners = new Map<string, Set<AgentRunner>>()
const activeSymposiumAborters = new Map<string, () => void>()
const pendingGoalConfirmations = new Map<string, {
  conversationId: string
  resolve: (approved: boolean) => void
}>()
const MAX_PERSISTED_TOOL_RESULT_CHARS = 12_000
const INTERNAL_TASK_TIMEOUT_MS = 3 * 60 * 1000

function resolvePendingGoalConfirmation(conversationId: string, approved: boolean): void {
  for (const [confirmationId, pending] of pendingGoalConfirmations) {
    if (pending.conversationId !== conversationId) continue
    pendingGoalConfirmations.delete(confirmationId)
    pending.resolve(approved)
  }
}

function requestGoalConfirmation(conversationId: string, goal: string, win: BrowserWindow): Promise<boolean> {
  // A conversation can only wait for one Goal decision at a time. A newer
  // proposal supersedes a stale card from an earlier tool iteration.
  resolvePendingGoalConfirmation(conversationId, false)
  const confirmationId = uuidv4()
  const requestedAt = Date.now()
  if (!win.isDestroyed()) {
    win.webContents.send(IPC.CHAT_STREAM, {
      conversationId,
      type: 'goal_confirmation',
      goalConfirmation: { id: confirmationId, goal, requestedAt },
    } satisfies ChatStreamEvent)
  }
  return new Promise<boolean>((resolve) => {
    pendingGoalConfirmations.set(confirmationId, { conversationId, resolve })
  })
}

async function controlBackgroundGoal(
  conversationId: string,
  action: BackgroundGoalAction,
): Promise<BackgroundGoalControlResult> {
  const planner = activeBackgroundGoalPlanners.get(conversationId)
  const snapshot = await getStorage().taskRuns.get(conversationId)

  if (action === 'status') return { handled: Boolean(planner), status: snapshot?.status }
  if (!planner) return { handled: false, status: snapshot?.status }

  if (action === 'pause') {
    planner.pause()
    if (snapshot) await getStorage().taskRuns.save({ ...snapshot, status: 'paused' })
    await getStorage().conversations.updateConversation(conversationId, { executionStatus: 'paused', executionUpdatedAt: Date.now() })
    await getAgentOsScheduler().transitionConversation(conversationId, 'goal', 'paused', 'Paused by the user.')
    return { handled: true, status: 'paused' }
  }

  if (action === 'resume') {
    planner.resume()
    if (snapshot) await getStorage().taskRuns.save({ ...snapshot, status: 'running' })
    await getStorage().conversations.updateConversation(conversationId, { executionStatus: 'running', executionUpdatedAt: Date.now() })
    await getAgentOsScheduler().transitionConversation(conversationId, 'goal', 'running', 'Resumed by the user.')
    return { handled: true, status: 'running' }
  }

  planner.abort()
  return { handled: false, status: snapshot?.status }
}

function activePlanContext(plan: ActivePlan | null): string {
  if (!plan) return ''
  const steps = plan.steps.map((step, index) => {
    const marker = step.id === plan.currentStepId ? ' <- current' : ''
    return `${index + 1}. [${step.status}] ${step.title}${marker}`
  }).join('\n')
  return [
    '--- Active Agent OS plan ---',
    `Objective: ${plan.objective}`,
    `Plan status: ${plan.status}`,
    steps || '(The plan is being prepared.)',
    'When the user says "continue" or "next" without naming another task, continue the current unfinished plan step. Treat unrelated questions as temporary discussion; do not replace this plan unless the user explicitly starts, switches, or cancels a plan.',
    '--- End active Agent OS plan ---',
  ].join('\n')
}

function compactToolResult(result: string): string {
  if (result.length <= MAX_PERSISTED_TOOL_RESULT_CHARS) return result
  return `${result.slice(0, MAX_PERSISTED_TOOL_RESULT_CHARS)}\n\n[Tool output truncated for conversation storage: ${result.length} characters total]`
}

function redactExecutionText(value: string): string {
  return value
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [已隐藏]')
}

function summarizeExecutionText(value: unknown, limit = 260): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = redactExecutionText(value.replace(/\s+/g, ' ').trim())
  if (!normalized) return undefined
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

function extractProgressUpdates(content: string): Array<{ kind: ProgressUpdateKind; content: string }> {
  const updates: Array<{ kind: ProgressUpdateKind; content: string }> = []
  const tagPattern = /<eva-progress(?:\s+kind=["'](thinking|finding|action|issue)["'])?\s*>([\s\S]*?)<\/eva-progress>/gi
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(content))) {
    const summary = summarizeExecutionText(match[2], 520)
    if (summary) updates.push({ kind: (match[1]?.toLowerCase() as ProgressUpdateKind | undefined) || 'thinking', content: summary })
  }
  return updates
}

function executionActionTitle(toolNames: string[]): string {
  const names = new Set(toolNames)
  if (names.has('manage_goal') || names.has('run_goal') || names.has('run_task')) return '正在推进任务计划并核对完成状态'
  if (names.has('write_file') || names.has('edit_file') || names.has('blender_run_script')) return '正在落地方案并更新项目产物'
  if (names.has('open_terminal') || names.has('read_terminal') || names.has('write_terminal') || names.has('close_terminal')) return '正在控制此对话的终端'
  if (names.has('execute_command')) return '正在执行验证并确认实际结果'
  if (names.has('web_search') || names.has('read_web_page')) return '正在补充外部资料并核对依据'
  if (names.has('search_code') || names.has('search_files') || names.has('project_search')) return '正在定位关键位置并核查影响范围'
  if (names.has('read_file') || names.has('list_directory') || names.has('file_info') || names.has('project_index_status')) return '正在核查项目现状和已有资料'
  return '正在执行本阶段必要操作'
}

function executionActionOutcome(toolNames: string[], results: Array<{ name: string; result: string; isError: boolean }>): string {
  const names = new Set(toolNames)
  const completed = results.filter((result) => !result.isError)
  const failed = results.length - completed.length
  if (failed > 0) return `本阶段有 ${failed} 项操作未完成，已保留有效结果并调整后续处理方向。`
  if (names.has('manage_goal')) {
    const goalResult = results.find((result) => result.name === 'manage_goal')?.result || ''
    const progress = goalResult.match(/Progress:\s*([^\n.]+)/i)?.[1]
    return progress ? `任务计划已推进，当前进度 ${progress.trim()}。` : '任务计划已推进，正在根据完成情况安排后续工作。'
  }
  if (names.has('write_file') || names.has('edit_file') || names.has('blender_run_script')) return `已完成 ${completed.length} 项项目更新，接下来会核对产物是否满足目标。`
  if (names.has('open_terminal') || names.has('read_terminal') || names.has('write_terminal') || names.has('close_terminal')) return '已完成此对话终端的受控操作。'
  if (names.has('execute_command')) return '已获得实际验证结果，正在判断是否需要修正方案。'
  if (names.has('web_search') || names.has('read_web_page')) return '已补充外部资料，正在结合项目约束判断其适用性。'
  if (names.has('search_code') || names.has('search_files') || names.has('project_search')) return '已定位相关位置，正在评估范围、依赖和可行路径。'
  if (names.has('read_file') || names.has('list_directory') || names.has('file_info') || names.has('project_index_status')) return `已完成 ${completed.length} 项资料与项目核查，正在归纳对当前决策有影响的事实。`
  return `已完成 ${completed.length} 项必要操作，正在评估结果并决定下一步。`
}

function executionThinkingLabel(content?: string): string {
  const normalized = (content || '').toLowerCase()
  if (normalized.includes('preparing the response')) return '正在理解请求并确定执行方式'
  if (normalized.includes('reviewing the tool results')) return '正在根据已获得的结果调整下一步'
  if (normalized.includes('reviewing progress')) return '正在检查已获得的证据是否足够'
  if (normalized.includes('continuing with an expanded')) return '需要补充证据，继续执行后续步骤'
  if (normalized.includes('synthesizing')) return '正在汇总已验证的结果'
  return '正在分析当前进展并决定下一步'
}

function selectAutoAgent(agents: AgentConfig[], content: string): AgentConfig | null {
  const byRole = (role: AgentConfig['role']) => agents.find((agent) => agent.role === role)

  if (/(multi[- ]?agent|team|collaborat|orchestrat|拆分任务|协作|编排|执行计划|目标分解|\bgoal\b)/i.test(content)) {
    return byRole('leader') || byRole('coder') || agents[0] || null
  }
  if (/(code review|security|audit|漏洞|审查|评审|\breview\b)/i.test(content)) {
    return byRole('reviewer') || byRole('coder') || agents[0] || null
  }
  if (/(research|investigat|analysis|architecture|调研|研究|分析|资料|报告|趋势|论文|搜索)/i.test(content)) {
    return byRole('researcher') || byRole('coder') || agents[0] || null
  }

  return byRole('coder') || agents[0] || null
}

function applyGoalProgress(current: GoalProgress | null, event: GoalEvent, conversationId: string): GoalProgress | null {
  switch (event.type) {
    case 'goal_started':
      return current || { goal: event.goal, steps: [], currentStepIndex: 0, totalSteps: 0, status: 'in_progress', startedAt: Date.now(), conversationId }
    case 'plan_created':
      return current ? { ...current, steps: event.steps, totalSteps: event.steps.length } : current
    case 'step_started':
      return current ? { ...current, currentStepIndex: event.stepIndex, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, status: 'in_progress', startedAt: Date.now(), attempt: event.attempt, maxAttempts: event.maxAttempts, attempts: event.attempts, ...(event.agentConversationId ? { agentConversationId: event.agentConversationId } : {}) } : step) } : current
    case 'step_conversation':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, agentConversationId: event.agentConversationId, handoff: event.handoff } : step) } : current
    case 'step_tool_call':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, toolCalls: [...(step.toolCalls || []), event.toolCall] } : step) } : current
    case 'step_tool_result':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, toolCalls: (step.toolCalls || []).map((toolCall) => toolCall.id === event.toolCallId ? { ...toolCall, result: event.result, isError: event.isError } : toolCall) } : step) } : current
    case 'step_retrying':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, status: 'in_progress', attempt: event.attempt, maxAttempts: event.maxAttempts, attempts: event.attempts, result: undefined } : step) } : current
    case 'step_completed':
    case 'step_failed':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, status: event.type === 'step_completed' ? 'completed' : 'failed', result: event.type === 'step_completed' ? event.result : event.error, attempts: event.attempts || step.attempts, completedAt: Date.now() } : step) } : current
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
    const workspacePath = conversationWorkspacePath(conversation, access.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath'))
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
        providerId: participant.providerId,
        providerName: participant.providerName,
        model: participant.model,
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

function primaryModelSupportsVision(agent: AgentConfig, provider: import('../providers/base-provider').LLMProvider): boolean {
  if (provider.type === 'anthropic') return true
  return provider.type === 'openai' && /(?:gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4-mini)/i.test(agent.model)
}

async function analyzeImagesWithAuthorizedPool(
  services: ChatServices,
  agent: AgentConfig,
  prompt: string,
  images: ChatImageAttachment[],
): Promise<string> {
  const pools = getStorage().config.get('modelPools')
  const candidates: ModelPoolEntry[] = []
  const seen = new Set<string>()
  for (const poolId of agent.modelPoolIds || []) {
    const router = new ModelRouter(pools, (entry) => Boolean(services.providerRegistry.get(entry.providerId)))
    for (const capability of ['vision', 'image'] as const) {
      const route = router.resolve({ poolId, capability })
      for (const entry of [route.primary, ...route.fallbacks]) {
        if (entry && !seen.has(entry.id)) {
          seen.add(entry.id)
          candidates.push(entry)
        }
      }
    }
  }
  if (!candidates.length) {
    throw new Error('The selected primary model does not support image input. Assign this agent a model pool with a Vision or Image route in Agent > Model access, or select a vision-capable primary model.')
  }

  const errors: string[] = []
  for (const entry of candidates) {
    const provider = services.providerRegistry.get(entry.providerId)
    if (!provider) continue
    try {
      const response = await provider.chatComplete({
        model: entry.model,
        messages: [
          { role: 'system', content: 'Analyze the attached image(s) for the user request. Return factual visual observations, relevant text, layout, and uncertainty. Do not claim to use tools or access anything outside these images.' },
          { role: 'user', content: prompt || 'Describe the attached image(s).', images: images.map((image) => ({ name: image.name, mediaType: image.mediaType, dataUrl: image.dataUrl })) },
        ],
        temperature: 0.2,
        maxTokens: 4096,
      })
      if (!response.content.trim()) throw new Error('Model returned an empty image analysis.')
      return `Image analysis from ${entry.name} (${entry.providerId} / ${entry.model}):\n${response.content}`
    } catch (error) {
      errors.push(`${entry.name}: ${formatProviderRequestFailure(error, provider, entry.model, 'model-pool')}`)
    }
  }
  throw new Error(`No model in the authorized visual pool could analyze the image.\n${errors.join('\n')}`)
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

  const runtimeProcess = await getAgentOsScheduler().startChild({
    conversationId: conversation.id,
    kind: 'team',
    agentId: leader.id,
    workspaceId: conversation.workspaceId,
    summary: 'A chat agent delegated work to the specialist team.',
  })
  const access = await getConversationAccess(conversation)
  const durableMemory = await getStorage().runtimeMemory.buildContext(conversation.id, conversation.workspaceId)
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
      workspacePath: conversationWorkspacePath(conversation),
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
    contextManager: new ContextManager({ durableMemory }),
    workspacePath: conversationWorkspacePath(conversation, access.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath')),
    fileAccessGrants: access.fileAccessGrants,
    fullFilesystemAccess: access.fullFilesystemAccess,
    fileService: services.fileService,
    terminalService: services.terminalService,
    createWorkerConversation,
    onWorkerEvent: persistWorkerEvent,
  })
  activeDelegatedTeamOrchestrators.get(conversation.id)?.abort()
  activeDelegatedTeamOrchestrators.set(conversation.id, orchestrator)

  try {
    let summary = ''
    for await (const event of orchestrator.run({ goal, messages: historyMessages })) {
      if (!win.isDestroyed()) win.webContents.send(IPC.TASK_STREAM, { ...event, conversationId: conversation.id })
      if (event.type === 'summary') summary = event.summary || ''
      if (event.type === 'error') throw new Error(event.error || 'Team orchestration failed.')
    }
    const result = summary || 'The specialist team completed the delegated work without a separate summary.'
    await getAgentOsScheduler().finishProcess(runtimeProcess.id, 'completed', result)
    return result
  } catch (error: any) {
    await getAgentOsScheduler().finishProcess(runtimeProcess.id, 'failed', error?.message ?? String(error))
    throw error
  } finally {
    if (activeDelegatedTeamOrchestrators.get(conversation.id) === orchestrator) {
      activeDelegatedTeamOrchestrators.delete(conversation.id)
    }
  }
}

function toChatStreamEvent(event: AgentEvent): ChatStreamEvent {
  switch (event.type) {
    case 'text':
      return { type: 'text_delta', content: event.content }
    case 'text_reset':
      return { type: 'text_reset' }
    case 'thinking':
      return { type: 'thinking', content: event.content }
    case 'reasoning':
      return { type: 'reasoning_delta', content: event.content }
    case 'tool_call':
      return { type: 'tool_call_start', toolCall: event.toolCall }
    case 'tool_result':
      return {
        type: 'tool_result',
        toolCallId: event.toolResult?.toolCallId,
        toolResult: event.toolResult?.result,
        isError: event.toolResult?.isError,
        protocol: event.toolResult?.protocol,
      }
    case 'error':
      return { type: 'error', error: event.error }
    case 'done':
      return { type: 'done', content: event.content, finishReason: event.finishReason, usage: event.usage }
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

/** Only project-bound conversations may carry a project workspace path. */
function conversationWorkspacePath(conversation: Conversation, fallback = ''): string {
  return conversation.workspaceId ? (conversation.workspacePath || fallback) : ''
}

export function registerConversationHandlers(services?: ChatServices): void {
  registerBackgroundGoalController(controlBackgroundGoal)
  // ─── Conversation CRUD ──────────────────────────────────────────────────────

  ipcMain.handle(IPC.CONVERSATION_LIST, async (): Promise<Conversation[]> => {
    if (services) scheduleLegacyTitleRefresh(services)
    return getStorage().conversations.listConversations()
  })

  ipcMain.handle(
    IPC.CONVERSATION_CREATE,
    async (
      _event,
      data: { title?: string; agentId?: string; mode?: 'normal' | 'expert' | 'goal'; workspaceId?: string; workspacePath?: string; accessScope?: Conversation['accessScope']; permissionLevel?: Conversation['permissionLevel']; fileAccessGrants?: Conversation['fileAccessGrants']; symposium?: Conversation['symposium'] }
    ): Promise<Conversation> => {
      const workspace = data.workspaceId ? await getStorage().workspaces.get(data.workspaceId) : null
      // New conversations inherit the configured primary chat Agent. Explicit
      // selections, including __auto__, always take precedence.
      const availableAgents = data.agentId ? [] : await getStorage().agents.listAgents()
      const primaryAgentId = getStorage().config.get('primaryChatAgentId')
      const defaultAgent = data.agentId
        ? null
        : availableAgents.find((agent) => agent.id === primaryAgentId) || availableAgents[0]
      const conversation = await getStorage().conversations.createConversation({
        title: data.title || 'New Conversation',
        titleSource: data.title && data.title !== 'New Conversation' ? 'manual' : 'auto',
        agentId: data.agentId || defaultAgent?.id || '__auto__',
        mode: data.mode || 'normal',
        workspaceId: workspace?.id,
        accessScope: workspace ? 'workspace' : data.accessScope,
        permissionLevel: data.permissionLevel || (workspace ? 'workspace' : 'full-access'),
        fileAccessGrants: data.fileAccessGrants || [],
        symposium: data.symposium,
        workspacePath: workspace?.path || data.workspacePath?.trim() || '',
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
      const storedMessages = await store.getMessages(id)
      const providersNeedingPricing = Array.from(new Set(storedMessages
        .filter((message) => message.usage && message.providerId)
        .map((message) => message.providerId)))
      await Promise.all(providersNeedingPricing.map((providerId) => ensureProviderPricing(providerId).catch(() => undefined)))
      const messages = storedMessages.map((message) => message.usage
        ? { ...message, usage: hydrateUsagePricing(message.providerId, message.model, message.usage) }
        : message)
      return { conversation, messages }
    }
  )

  ipcMain.handle(
    IPC.CONVERSATION_UPDATE,
    async (
      event,
      id: string,
      data: Partial<Pick<Conversation, 'title' | 'titleSource' | 'agentId' | 'archived' | 'permissionLevel' | 'fileAccessGrants' | 'multiDimensionalIndexEnabled' | 'symposium' | 'executionStatusAcknowledgedAt'>>
    ): Promise<void> => {
      const conversation = await getStorage().conversations.getConversation(id)
      await getStorage().conversations.updateConversation(id, {
        ...data,
        ...(data.title && !data.titleSource ? { titleSource: 'manual' } : {}),
      })

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

  ipcMain.handle(
    IPC.CONVERSATION_MESSAGE_UPDATE,
    async (_event, conversationId: string, messageId: string, data: Partial<Pick<ChatMessage, 'favorited'>>): Promise<void> => {
      await getStorage().conversations.updateMessage(conversationId, messageId, data)
    }
  )

  ipcMain.handle(
    IPC.CONVERSATION_MESSAGES_DELETE_FROM,
    async (_event, conversationId: string, messageId: string): Promise<void> => {
      await getStorage().conversations.deleteMessages(conversationId, messageId)
    }
  )

  // ─── Chat: send (fire-and-forget; events streamed via CHAT_STREAM) ──────────

  ipcMain.on(
    IPC.CHAT_SEND,
    async (event, payload: { conversationId: string; message: string; agentId?: string; images?: ChatImageAttachment[]; attachments?: ChatDocumentAttachment[]; quotedMessage?: ChatMessageReference }) => {
      const { conversationId, message } = payload
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      resolvePendingGoalConfirmation(conversationId, false)
      let runner: AgentRunner | null = null
      let runtimeProcessId: string | null = null
      let activeAgentIdentity: Pick<ChatStreamEvent, 'agentId' | 'agentName'> = {}

      const sendStreamEvent = (streamEvent: ChatStreamEvent): void => {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.CHAT_STREAM, { ...streamEvent, conversationId, ...activeAgentIdentity })
        }
      }
      const send = (agentEvent: AgentEvent): void => sendStreamEvent(toChatStreamEvent(agentEvent))

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
        const memory = await getStorage().runtimeMemory.buildContext(conversationId, conversation.workspaceId)
        const activePlanScope = conversation.workspaceId
          ? `workspace:${conversation.workspaceId}`
          : conversation.workspacePath?.trim()
            ? `workspace-path:${conversation.workspacePath.trim().toLowerCase()}`
            : `conversation:${conversationId}`
        const durableMemory = [memory, activePlanContext(await getStorage().activePlans.getActive(activePlanScope))]
          .filter(Boolean)
          .join('\n\n')
        const historyMessages = sanitizeToolHistory(await convStore.getMessages(conversationId)).map((item) => ({
          ...item,
          images: loadReferenceImages(item.images, false),
        }))

        // 2. Load agent config — prefer payload agentId, fallback to conversation.agentId, then first available
        const isAutoRoutedChat =
          payload.agentId === '__auto__' || !payload.agentId || payload.agentId === '__direct__'
        const allAgents = await getStorage().agents.listAgents()
        const agentId = isAutoRoutedChat ? '' : (payload.agentId || conversation.agentId)
        let agentConfig = agentId ? await getStorage().agents.getAgent(agentId) : null
        if (!agentConfig) {
          agentConfig = isAutoRoutedChat
            ? selectAutoAgent(allAgents, message)
            : allAgents[0] || null
        }
        if (!agentConfig) {
          send({ type: 'error', error: 'No agent available. Please configure an agent first.' })
          send({ type: 'done', content: '' })
          return
        }

        // 3. Built-in agents inherit the active Settings provider and model. Custom agents
        // retain their individual configuration as an explicit advanced override.
        const effectiveAgentConfig = resolveEffectiveAgentConfig(agentConfig, {
          providerId: getStorage().config.get('activeProviderId'),
          model: getStorage().config.getActiveModel(),
        })
        activeAgentIdentity = { agentId: effectiveAgentConfig.id, agentName: effectiveAgentConfig.name }

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
        const shouldGenerateTitle = conversation.messageCount === 0

        // 4. Save user message to storage immediately
        const userMessageId = uuidv4()
        const referenceImages = loadReferenceImages(payload.images, true)
        const documentContext = await buildDocumentAttachmentContext(payload.attachments)
        const imageContext = referenceImages?.length && !primaryModelSupportsVision(effectiveAgentConfig, provider)
          ? await analyzeImagesWithAuthorizedPool(services, effectiveAgentConfig, message, referenceImages)
          : ''
        const userChatMessage: ChatMessage = {
          id: userMessageId,
          conversationId,
          role: 'user',
          content: message,
          attachmentContext: [documentContext, imageContext].filter(Boolean).join('\n\n') || undefined,
          attachments: payload.attachments,
          images: referenceImages,
          quotedMessage: payload.quotedMessage,
          timestamp: Date.now(),
        }
        await convStore.addMessage(conversationId, { ...userChatMessage, images: persistableImages(referenceImages) })
        await convStore.updateConversation(conversationId, { executionStatus: 'running', executionUpdatedAt: Date.now() })
        win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)

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
        const runnerWorkspacePath = conversationWorkspacePath(conversation, workspaceAccess.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath'))
        const runTask = automation.task.enabled && automation.task.autoInvoke
          ? async (task: string): Promise<string> => {
              // A new nested task supersedes an older one for this conversation.
              activeTaskRunners.get(conversationId)?.abort()
              const worker = new AgentRunner({
                conversationId,
                agentConfig: effectiveAgentConfig,
                provider,
                toolRegistry: services.toolRegistry,
                contextManager: new ContextManager({ durableMemory }),
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
        let goalExecutionDeclined = false
        const runGoal = automation.goal.enabled && automation.goal.autoInvoke
          ? async (goal: string, resumeProgressOrEstimatedSteps?: GoalProgress | number | null, maybeEstimatedSteps?: number): Promise<string> => {
              // Tool-triggered Goal calls provide an estimate. Existing manual
              // resume calls provide a checkpoint as the second argument.
              const resumeProgress = typeof resumeProgressOrEstimatedSteps === 'number' || resumeProgressOrEstimatedSteps == null
                ? null
                : resumeProgressOrEstimatedSteps
              const estimatedSteps = typeof resumeProgressOrEstimatedSteps === 'number'
                ? resumeProgressOrEstimatedSteps
                : maybeEstimatedSteps
              if (estimatedSteps !== undefined && estimatedSteps < 5) {
                return 'Goal execution requires at least 5 independent execution steps. Continue this request directly with the available tools.'
              }
              if (goalExecutionDeclined) {
                return 'Goal execution was declined for this request. Continue the user request directly in regular chat with the available tools; do not call run_goal again during this turn.'
              }
              const approved = await requestGoalConfirmation(conversationId, goal, win)
              if (!approved) {
                goalExecutionDeclined = true
                return 'The user chose regular chat instead of Goal execution. Continue the request directly with the available tools and provide the result in this conversation; do not call run_goal again during this turn.'
              }
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
                contextManager: new ContextManager({ durableMemory }),
                workspacePath: runnerWorkspacePath,
                fileAccessGrants: workspaceAccess.fileAccessGrants,
                fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
                fileService: services.fileService,
                terminalService: services.terminalService,
                maxSteps: automation.goal.maxSteps,
                timeout,
                prepareStepConversation: async ({ step, handoff }) => {
                  const prepared = await prepareGoalStepConversation({ parent: conversation, agentConfig: effectiveAgentConfig, workspacePath: runnerWorkspacePath, step, handoff })
                  if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, prepared.conversationId)
                  return prepared
                },
                persistStepEvent: ({ step, conversationId: stepConversationId, event }) => persistGoalStepEvent({ step, conversationId: stepConversationId, event, agentConfig: effectiveAgentConfig }),
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
              const runtimeProcess = await getAgentOsScheduler().startChild({
                conversationId,
                kind: 'goal',
                agentId: effectiveAgentConfig.id,
                workspaceId: conversation.workspaceId,
                summary: 'A chat agent started a background Goal.',
              })

              void (async () => {
                let progress: GoalProgress | null = resumeProgress || null
                try {
                  for await (const goalEvent of planner.run({ goal, maxSteps: automation.goal.maxSteps, timeout, autoAdjust: true }, resumeProgress || undefined)) {
                    progress = applyGoalProgress(progress, goalEvent, conversationId)
                    await getStorage().taskRuns.save({
                      conversationId,
                      kind: 'goal',
                      status: planner.paused ? 'paused' : goalEvent.type === 'done'
                        ? (goalEvent.progress.status === 'completed' ? 'completed' : goalEvent.progress.status === 'cancelled' ? 'cancelled' : 'failed')
                        : goalEvent.type === 'error' ? 'failed' : 'running',
                      progress: progress || undefined,
                      summary: goalEvent.type === 'summary' ? goalEvent.content : progress?.summary,
                      error: goalEvent.type === 'error' ? goalEvent.error : undefined,
                    })
                    if (goalEvent.type === 'done') {
                      const status = goalEvent.progress.status === 'completed'
                        ? 'completed'
                        : goalEvent.progress.status === 'cancelled'
                          ? 'cancelled'
                          : 'failed'
                      await getAgentOsScheduler().finishProcess(
                        runtimeProcess.id,
                        status,
                        goalEvent.progress.summary || (status === 'completed' ? 'Background Goal completed.' : 'Background Goal did not complete.'),
                      )
                    } else if (goalEvent.type === 'error') {
                      await getAgentOsScheduler().finishProcess(runtimeProcess.id, 'failed', goalEvent.error)
                    }
                    if (!win.isDestroyed()) {
                      win.webContents.send(IPC.TASK_GOAL_STREAM, { ...goalEvent, conversationId })
                    }
                  }
                } catch (error: any) {
                  const message = error?.message ?? String(error)
                  await getStorage().taskRuns.save({ conversationId, kind: 'goal', status: 'failed', progress: progress || undefined, error: message })
                  await getAgentOsScheduler().finishProcess(runtimeProcess.id, 'failed', message)
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
                  await getAgentOsScheduler().transitionConversation(conversationId, 'goal', 'paused', 'Paused by the user.')
                  return 'Goal task was paused after its current operation.'
                }
                backgroundPlanner.abort()
                if (snapshot) await getStorage().taskRuns.save({ ...snapshot, status: 'cancelled' })
                await getAgentOsScheduler().transitionConversation(conversationId, 'goal', 'cancelled', 'Stopped by the user.')
                return 'Goal task was cancelled.'
              }

              if (action === 'resume') {
                if (backgroundPlanner) {
                  backgroundPlanner.resume()
                  if (snapshot) await getStorage().taskRuns.save({ ...snapshot, status: 'running' })
                  await getAgentOsScheduler().transitionConversation(conversationId, 'goal', 'running', 'Resumed by the user.')
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
          contextManager: new ContextManager({ durableMemory }),
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
        const runtimeProcess = await getAgentOsScheduler().startInteractive({
          conversationId,
          agentId: effectiveAgentConfig.id,
          workspaceId: conversation.workspaceId,
          summary: `${effectiveAgentConfig.name} is handling a chat request.`,
          resourceKey: `conversation:${conversationId}`,
        })
        runtimeProcessId = runtimeProcess.id
        getAgentOsScheduler().attachInteractiveAbort(conversationId, runtimeProcess.id, () => runner?.abort())

        // 6. Execute the ReAct loop and stream events
        const allToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
        const allToolResults: Array<{ toolCallId: string; name: string; result: string; isError: boolean; protocol?: import('../../shared/types/execution-protocol').ExecutionEnvelope }> = []
        let assistantContent = ''
        let assistantReasoningContent = ''
        let assistantUsage: ChatUsage | undefined
        let assistantFinishReason: string | undefined
        let runError: string | null = null
        // Keep only a possible partial eva-progress tag between token chunks.
        // Ordinary response text must not wait for the model's final `done`
        // event, otherwise every provider appears to be non-streaming.
        let pendingProgressMarkup = ''
        let latestProgressContent = ''
        const progressUpdates: ProgressUpdate[] = []
        const executionTrace: ExecutionTraceEntry[] = []
        const executionTimeline: ExecutionTimelineEntry[] = []
        let currentAction: {
          entry: ExecutionTraceEntry
          toolNames: string[]
          results: Array<{ name: string; result: string; isError: boolean }>
        } | null = null

        const emitExecutionTrace = (): void => {
          sendStreamEvent({
            type: 'execution_trace',
            executionTrace: executionTrace.map((entry) => ({ ...entry })),
          })
        }
        const emitExecutionTimeline = (): void => {
          sendStreamEvent({
            type: 'execution_timeline',
            executionTimeline: executionTimeline.map((entry) => ({
              ...entry,
              toolCall: entry.toolCall
                ? { ...entry.toolCall, arguments: { ...entry.toolCall.arguments } }
                : undefined,
            })),
          })
        }
        const addTraceEntry = (entry: Omit<ExecutionTraceEntry, 'id' | 'timestamp'>): ExecutionTraceEntry => {
          const traceEntry: ExecutionTraceEntry = {
            ...entry,
            id: uuidv4(),
            timestamp: Date.now(),
          }
          executionTrace.push(traceEntry)
          emitExecutionTrace()
          return traceEntry
        }
        const completeActiveNonToolTraceEntries = (): void => {
          let changed = false
          for (const entry of executionTrace) {
            if (entry.status === 'active' && entry.kind !== 'tool') {
              entry.status = 'completed'
              changed = true
            }
          }
          if (changed) emitExecutionTrace()
        }
        const completeCurrentAction = (): void => {
          if (!currentAction) return
          const failed = currentAction.results.filter((result) => result.isError).length
          currentAction.entry.status = failed > 0 ? 'failed' : 'completed'
          currentAction.entry.title = failed > 0 ? '本阶段出现问题，正在调整处理方向' : '本阶段行动已完成'
          currentAction.entry.detail = executionActionOutcome(currentAction.toolNames, currentAction.results)
          emitExecutionTrace()
          if (failed > 0) {
            addTraceEntry({
              kind: 'issue',
              status: 'failed',
              title: '已识别执行阻塞，后续会避开或修正该路径',
            })
          } else {
            addTraceEntry({
              kind: 'observation',
              status: 'completed',
              title: '已获得阶段性结论，正在据此调整下一步',
            })
          }
          currentAction = null
        }

        const publishProgress = async (kind: ProgressUpdateKind, content: string): Promise<void> => {
          const summary = summarizeExecutionText(content, 520)
          if (!summary || summary === latestProgressContent) return
          latestProgressContent = summary
          const progressUpdate: ProgressUpdate = {
            id: uuidv4(),
            kind,
            content: summary,
            timestamp: Date.now(),
          }
          progressUpdates.push(progressUpdate)
          const progressMessage: ChatMessage = {
            id: progressUpdate.id,
            conversationId,
            role: 'assistant',
            content: summary,
            progressKind: kind,
            agentId: effectiveAgentConfig.id,
            agentName: effectiveAgentConfig.name,
            timestamp: progressUpdate.timestamp,
          }
          await convStore.addMessage(conversationId, progressMessage)
          if (!win.isDestroyed()) {
            win.webContents.send(IPC.CHAT_STREAM, {
              conversationId,
              type: 'progress',
              messageId: progressMessage.id,
              content: summary,
              progressKind: kind,
            } satisfies ChatStreamEvent)
          }
        }
        const progressOpeningTag = '<eva-progress'
        const progressClosingTag = '</eva-progress>'
        const streamTextDelta = async (content: string): Promise<void> => {
          pendingProgressMarkup += content

          while (pendingProgressMarkup) {
            const normalized = pendingProgressMarkup.toLowerCase()
            const openingIndex = normalized.indexOf(progressOpeningTag)

            if (openingIndex < 0) {
              // A tag opener can be split across chunks. Retain only the small
              // matching suffix and immediately forward everything else.
              const maxPrefixLength = Math.min(progressOpeningTag.length - 1, pendingProgressMarkup.length)
              let retainedLength = 0
              for (let length = maxPrefixLength; length > 0; length--) {
                if (progressOpeningTag.startsWith(normalized.slice(-length))) {
                  retainedLength = length
                  break
                }
              }
              const visible = pendingProgressMarkup.slice(0, pendingProgressMarkup.length - retainedLength)
              pendingProgressMarkup = pendingProgressMarkup.slice(pendingProgressMarkup.length - retainedLength)
              if (visible) send({ type: 'text', content: visible })
              return
            }

            if (openingIndex > 0) {
              send({ type: 'text', content: pendingProgressMarkup.slice(0, openingIndex) })
              pendingProgressMarkup = pendingProgressMarkup.slice(openingIndex)
              continue
            }

            const closingIndex = normalized.indexOf(progressClosingTag)
            if (closingIndex < 0) return

            const markupEnd = closingIndex + progressClosingTag.length
            const updates = extractProgressUpdates(pendingProgressMarkup.slice(0, markupEnd))
            pendingProgressMarkup = pendingProgressMarkup.slice(markupEnd)
            for (const update of updates) await publishProgress(update.kind, update.content)
          }
        }

        const clearPendingProgressMarkup = (): void => {
          // A tool call can only follow a complete, user-visible progress tag.
          // Drop malformed/incomplete tag fragments rather than exposing them.
          pendingProgressMarkup = ''
        }

        addTraceEntry({
          kind: 'plan',
          status: 'active',
          title: '正在理解目标并制定首轮处理方向',
        })
        const primarySupportsVision = primaryModelSupportsVision(effectiveAgentConfig, provider)
        const runnerHistory = primarySupportsVision ? historyMessages : historyMessages.map((history) => history.images?.length ? { ...history, images: undefined } : history)
        const runnerMessage = imageContext ? { ...userChatMessage, images: undefined } : userChatMessage
        for await (const agentEvent of runner.run({ messages: runnerHistory, newMessage: runnerMessage })) {
          // Accumulate content and tool info for persistence
          if (agentEvent.type === 'text' && agentEvent.content) {
            await streamTextDelta(agentEvent.content)
            continue
          }
          if (agentEvent.type === 'text_reset') {
            clearPendingProgressMarkup()
            assistantContent = ''
            send(agentEvent)
            continue
          }
          if (agentEvent.type === 'reasoning' && agentEvent.content) {
            assistantReasoningContent += agentEvent.content
            const latest = executionTimeline[executionTimeline.length - 1]
            if (latest?.kind === 'reasoning') {
              latest.content = `${latest.content || ''}${agentEvent.content}`
            } else {
              executionTimeline.push({ id: uuidv4(), kind: 'reasoning', content: agentEvent.content, timestamp: Date.now() })
            }
            emitExecutionTimeline()
          }
          if (agentEvent.type === 'thinking') {
            completeCurrentAction()
            completeActiveNonToolTraceEntries()
            addTraceEntry({
              kind: 'activity',
              status: 'active',
              title: executionThinkingLabel(agentEvent.content),
            })
          }
          if (agentEvent.type === 'tool_call' && agentEvent.toolCall) {
            clearPendingProgressMarkup()
            allToolCalls.push(agentEvent.toolCall)
            executionTimeline.push({
              id: uuidv4(),
              kind: 'tool',
              timestamp: Date.now(),
              toolCall: {
                id: agentEvent.toolCall.id,
                name: agentEvent.toolCall.name,
                arguments: { ...agentEvent.toolCall.arguments },
              },
            })
            emitExecutionTimeline()
            if (!currentAction) {
              completeActiveNonToolTraceEntries()
              currentAction = {
                entry: addTraceEntry({
                  kind: 'tool',
                  status: 'active',
                  title: executionActionTitle([agentEvent.toolCall.name]),
                }),
                toolNames: [],
                results: [],
              }
            }
            currentAction.toolNames.push(agentEvent.toolCall.name)
            currentAction.entry.title = executionActionTitle(currentAction.toolNames)
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
            const timelineTool = [...executionTimeline].reverse().find((entry) => entry.kind === 'tool' && entry.toolCall?.id === agentEvent.toolResult?.toolCallId)
            if (timelineTool?.toolCall) {
              timelineTool.toolCall = {
                ...timelineTool.toolCall,
                result: compactToolResult(agentEvent.toolResult.result),
                isError: agentEvent.toolResult.isError,
                protocol: agentEvent.toolResult.protocol,
              }
              emitExecutionTimeline()
            }
            currentAction?.results.push({
              name: agentEvent.toolResult.name,
              result: agentEvent.toolResult.result,
              isError: agentEvent.toolResult.isError,
            })
            void recordActivity({
              category: 'tool',
              action: 'tool.completed',
              status: agentEvent.toolResult.isError ? 'error' : 'success',
              summary: `${agentEvent.toolResult.name} ${agentEvent.toolResult.isError ? 'failed' : 'completed'}.`,
              conversationId,
              workspaceId: conversation.workspaceId,
            }, win)
          }
          if (agentEvent.type === 'done') {
            // `done` carries the canonical, complete response. Any remaining
            // buffer is only an incomplete tag opener and must not be shown.
            clearPendingProgressMarkup()
            if (agentEvent.content) {
              assistantContent = agentEvent.content
                .replace(/<eva-progress(?:\s+kind=["'](?:thinking|finding|action|issue)["'])?\s*>[\s\S]*?<\/eva-progress>/gi, '')
                .trim()
              agentEvent.content = assistantContent
            }
            assistantUsage = agentEvent.usage
            assistantFinishReason = agentEvent.finishReason
            completeCurrentAction()
            completeActiveNonToolTraceEntries()
            addTraceEntry({
              kind: 'result',
              status: 'completed',
              title: '已完成本次处理，正在整理回复',
            })
          }
          if (agentEvent.type === 'error') {
            runError = agentEvent.error || 'The model response failed.'
            completeCurrentAction()
            completeActiveNonToolTraceEntries()
            addTraceEntry({
              kind: 'issue',
              status: 'failed',
              title: '执行过程中遇到问题',
              detail: summarizeExecutionText(runError),
            })
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
                  protocol: result?.protocol,
                }
              })
            : undefined

        const assistantChatMessage: ChatMessage = {
          id: assistantMessageId,
          conversationId,
          role: 'assistant',
          content: runError && !assistantContent && allToolCalls.length === 0 ? `Error: ${runError}` : assistantContent,
          reasoningContent: assistantReasoningContent || undefined,
          executionTrace: executionTrace.length > 0 ? executionTrace : undefined,
          executionTimeline: executionTimeline.length > 0 ? executionTimeline : undefined,
          progressUpdates: progressUpdates.length > 0 ? progressUpdates : undefined,
          toolCalls: toolCallsForMessage,
          agentId: effectiveAgentConfig.id,
          agentName: effectiveAgentConfig.name,
          providerId: effectiveAgentConfig.providerId,
          providerName: getStorage().config.getProvider(effectiveAgentConfig.providerId)?.name || effectiveAgentConfig.providerId,
          model: effectiveAgentConfig.model,
          usage: assistantUsage,
          finishReason: assistantFinishReason,
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
            agentId: effectiveAgentConfig.id,
            agentName: effectiveAgentConfig.name,
            timestamp: Date.now(),
          }
          await convStore.addMessage(conversationId, toolMessage)
        }
        const latestConversation = await convStore.getConversation(conversationId)
        if (latestConversation?.executionStatus !== 'cancelled') {
          await convStore.updateConversation(conversationId, {
            executionStatus: runError ? 'failed' : 'completed',
            executionUpdatedAt: Date.now(),
          })
        }
        await getStorage().runtimeMemory.recordConversationTurn({
          conversationId,
          workspaceId: conversation.workspaceId,
          assistantMessageId,
          userRequest: message,
          outcome: assistantChatMessage.content,
          status: latestConversation?.executionStatus === 'cancelled' ? 'cancelled' : runError ? 'failed' : 'completed',
        })
        win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
        void recordActivity({
          category: 'agent',
          action: runError ? 'agent.failed' : 'agent.completed',
          status: runError ? 'error' : 'success',
          summary: runError || `${effectiveAgentConfig.name} completed the response.`,
          conversationId,
          workspaceId: conversation.workspaceId,
        }, win)
        if (runtimeProcessId) {
          await getAgentOsScheduler().finishInteractive(
            runtimeProcessId,
            latestConversation?.executionStatus === 'cancelled' ? 'cancelled' : runError ? 'failed' : 'completed',
            runError || `${effectiveAgentConfig.name} completed the chat request.`,
          )
        }
        if (shouldGenerateTitle) {
          void generateConversationTitle({
            conversationId,
            firstMessage: message,
            provider,
            model: effectiveAgentConfig.model,
            notify: (id) => {
              if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, id)
            },
          })
        }
      } catch (err: any) {
        if (runtimeProcessId) {
          await getAgentOsScheduler().finishInteractive(runtimeProcessId, 'failed', err?.message ?? String(err))
        }
        try {
          await getStorage().conversations.updateConversation(conversationId, {
            executionStatus: 'failed',
            executionUpdatedAt: Date.now(),
          })
          if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
        } catch {
          // The conversation may not exist when validation failed before loading it.
        }
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

  ipcMain.on(IPC.CHAT_ABORT, (event, conversationId?: string) => {
    if (conversationId) {
      resolvePendingGoalConfirmation(conversationId, false)
      activeRunners.get(conversationId)?.abort()
      activeTaskRunners.get(conversationId)?.abort()
      activeBackgroundGoalPlanners.get(conversationId)?.abort()
      activeDelegatedTeamOrchestrators.get(conversationId)?.abort()
      activeSymposiumAborters.get(conversationId)?.()
      activeTaskRunners.delete(conversationId)
      void getAgentOsScheduler().cancelInteractive(conversationId)
      void getAgentOsScheduler().transitionConversation(conversationId, 'goal', 'cancelled', 'Stopped by the user.')
      void getAgentOsScheduler().transitionConversation(conversationId, 'team', 'cancelled', 'Stopped by the user.')
      void getStorage().conversations.updateConversation(conversationId, {
        executionStatus: 'cancelled',
        executionUpdatedAt: Date.now(),
      }).then(() => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win && !win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
      }).catch(() => undefined)
    }
  })

  ipcMain.handle(
    IPC.CHAT_GOAL_CONFIRMATION_DECIDE,
    async (_event, payload: { conversationId?: string; confirmationId?: string; approved?: boolean }): Promise<boolean> => {
      const confirmationId = typeof payload?.confirmationId === 'string' ? payload.confirmationId : ''
      const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : ''
      const pending = confirmationId ? pendingGoalConfirmations.get(confirmationId) : undefined
      if (!pending || pending.conversationId !== conversationId) return false

      pendingGoalConfirmations.delete(confirmationId)
      pending.resolve(payload.approved === true)
      return true
    }
  )

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
