import fs from 'fs'
import path from 'path'
import { BrowserWindow } from 'electron'
import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import type { Conversation, ChatDocumentAttachment, ChatImageAttachment, ChatMessage, ChatMessageReference, ChatUsage, ToolCall, ChatStreamEvent, ExecutionTimelineEntry, ProgressUpdate, ProgressUpdateKind } from '../../shared/types/conversation'
import type { AgentConfig, AgentEvent } from '../../shared/types/agent'
import type { ToolRegistry, FileService, TerminalService } from '../tools'
import type { ProviderRegistry } from '../providers'
import { AgentRunner } from '../agent-engine/agent-runner'
import { ContextManager } from '../agent-engine/context'
import { TeamOrchestrator } from '../agent-engine/team-orchestrator'
import { GoalPlanner } from '../agent-engine/goal-planner'
import type { GoalEvent } from '../agent-engine/goal-planner'
import { getStorage, type StorageManager } from '../storage'
import { getAgentOsScheduler } from '../services/agent-os-scheduler'
import { v4 as uuidv4 } from 'uuid'
import { recordActivity } from '../services/activity-log'
import { sanitizeToolHistory } from '../agent-engine/tool-history'
import { SpecService } from '../services/spec-service'
import { clearSessionApprovals, createLocalToolApproval, rejectAllPendingApprovalsForConversation, resolvePendingApproval } from '../services/tool-approval-policy'
import type { AutomationConfig } from '../../shared/types/automation'
import { DEFAULT_AUTOMATION_CONFIG } from '../../shared/types/automation'
import type { ChatMessageInput } from '../../shared/types/provider'
import type { GoalProgress, TaskCheckpoint, TaskPlan, TaskRunSnapshot, TeamEvent } from '../../shared/types/task'
import { prepareGoalStepConversation, persistGoalStepEvent } from '../services/goal-step-conversation'
import { resolveEffectiveAgentConfig } from '../services/effective-agent-config'
import type { SymposiumContinueInput, SymposiumStartInput } from '../../shared/types/symposium'
import { controlForegroundGoal } from './task'
import { TurnProgressProjector, isAnswerLikeContent, stripProgressBlocks, toProgressSummaries, unwrapProgressTags } from './progress-protocol'
import { registerBackgroundGoalController, type BackgroundGoalAction, type BackgroundGoalControlResult } from '../services/background-goal-control'
import { generateConversationTitle, refreshLegacyConversationTitles } from '../services/conversation-title-service'
import { buildDocumentAttachmentContext } from '../services/document-attachment-service'
import { ModelRouter } from '../services/model-router'
import type { ModelPoolEntry } from '../../shared/types/model-pool'
import type { ActivePlan } from '../../shared/types/active-plan'
import { ConversationLifecycleService, type CreateConversationInput, type UpdateConversationInput } from '../services/conversation-lifecycle-service'
import { formatProviderRequestFailure } from '../services/provider-request-diagnostics'
import { resolveAssistantTurnContent } from '../services/assistant-turn-content'
import { activeRunRegistry } from '../services/run-registry'
import { SymposiumExecutionService } from '../services/symposium-execution-service'
import { TaskRunLifecycleService } from '../services/task-run-lifecycle-service'
import type { MemoryAgentService } from '../services/memory-agent-service'
import { toPublicExecutionNote } from './public-execution-trace'

export interface ChatServices {
  storage: StorageManager
  toolRegistry: ToolRegistry
  providerRegistry: ProviderRegistry
  fileService: FileService
  terminalService: TerminalService
  memoryAgent: MemoryAgentService
}

// Each conversation owns its runner. A model connection may be shared, but the
// prompt history, cancellation handle, and lifecycle must stay conversation-scoped.
const activeRunners = activeRunRegistry.forKind<AgentRunner>('chat')
// `run_task` creates a nested runner under the active chat runner. Keep its
// handle separately so cancellation and replacement cannot leave it orphaned.
const activeTaskRunners = activeRunRegistry.forKind<AgentRunner>('chat-task')
// A cancelled/replaced IPC handler can still finish its async setup after a
// newer message has started. The token prevents stale events and responses
// from being delivered to or persisted for the newer request.
const activeChatRunTokens = new Map<string, string>()
// Runs the user stopped explicitly. Unlike a superseded run, a stopped run
// still stores the text it had already streamed, marked as cancelled.
const userStoppedChatRunTokens = new Set<string>()
let legacyTitleRefreshTimer: ReturnType<typeof setTimeout> | undefined

function scheduleLegacyTitleRefresh(services: ChatServices): void {
  if (legacyTitleRefreshTimer) return

  const runWhenIdle = (): void => {
    if (activeRunners.size > 0 || activeTaskRunners.size > 0) {
      legacyTitleRefreshTimer = setTimeout(runWhenIdle, 5_000)
      return
    }

    legacyTitleRefreshTimer = undefined
    const provider = services.providerRegistry.get(services.storage.config.get('activeProviderId'))
    const model = services.storage.config.getActiveModel()
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
const activeBackgroundGoalPlanners = activeRunRegistry.forKind<GoalPlanner>('background-goal')
const activeDelegatedTeamOrchestrators = activeRunRegistry.forKind<TeamOrchestrator>('delegated-team')
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
    await getAgentOsScheduler().transitionConversation(conversationId, 'goal', 'paused', 'Paused by the user.')
    return { handled: true, status: 'paused' }
  }

  if (action === 'resume') {
    planner.resume()
    if (snapshot) await getStorage().taskRuns.save({ ...snapshot, status: 'running' })
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
    'The active user message always has priority over this plan. Continue the plan only when the active message explicitly says to continue, resume, proceed, or clearly refers to this plan. For unrelated questions, including greetings and short standalone questions, answer the active message directly and do not apply plan assumptions.',
    '--- End active Agent OS plan ---',
  ].join('\n')
}

function compactToolResult(result: string): string {
  if (result.length <= MAX_PERSISTED_TOOL_RESULT_CHARS) return result
  return `${result.slice(0, MAX_PERSISTED_TOOL_RESULT_CHARS)}\n\n[Tool output truncated for conversation storage: ${result.length} characters total]`
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
    resourceKey: conversation.workspaceId ? `workspace:${conversation.workspaceId}` : `conversation:${conversation.id}`,
    summary: 'A chat agent delegated work to the specialist team.',
  })
  const taskLifecycle = new TaskRunLifecycleService(getStorage())
  let currentPlan: TaskPlan | undefined
  let checkpoints: TaskCheckpoint[] = []
  let finalSummary: string | undefined
  let executionFailed = false
  let wasCancelled = false

  // Chat-triggered team work must have the same durable execution record as
  // explicit Expert tasks. Otherwise the right task workspace remains Ready
  // even while the orchestrator is running.
  const persistTeamSnapshot = async (status: TaskRunSnapshot['status']): Promise<void> => {
    await getStorage().taskRuns.save({
      conversationId: conversation.id,
      kind: 'expert',
      status,
      goal,
      plan: currentPlan,
      summary: finalSummary,
      error: executionFailed ? 'Team orchestration failed.' : undefined,
      checkpoints,
    })
    await taskLifecycle.syncActivePlan(conversation.id)
  }

  const applyTeamEvent = (event: TeamEvent): void => {
    if (event.type === 'plan_created' && event.plan) {
      currentPlan = event.plan
      checkpoints = [{
        id: 'plan-created',
        title: 'Execution plan created',
        description: `${event.plan.subtasks.length} tasks ready for execution.`,
        status: 'recorded',
        createdAt: Date.now(),
        feedback: [],
      }]
      return
    }
    if (!currentPlan || !event.subtaskId) return
    const status = event.type === 'task_assigned' ? 'pending'
      : event.type === 'task_progress' ? 'in_progress'
        : event.type === 'task_completed' ? 'completed'
          : event.type === 'task_failed' ? 'failed' : undefined
    if (!status) return
    currentPlan = {
      ...currentPlan,
      subtasks: currentPlan.subtasks.map((subtask) => subtask.id === event.subtaskId
        ? {
            ...subtask,
            ...(event.subtask || {}),
            assignedAgentId: event.agentId || event.subtask?.assignedAgentId || subtask.assignedAgentId,
            assignedAgentName: event.agentName || event.subtask?.assignedAgentName || subtask.assignedAgentName,
            status,
            result: event.progress || event.result || event.error || subtask.result,
            completedAt: status === 'completed' || status === 'failed' ? Date.now() : subtask.completedAt,
          }
        : subtask),
    }
    if (event.type === 'task_completed' || event.type === 'task_failed') {
      const existing = checkpoints.find((checkpoint) => checkpoint.id === `team-${event.subtaskId}`)
      const checkpoint = {
        id: `team-${event.subtaskId}`,
        title: event.subtask?.title || currentPlan.subtasks.find((subtask) => subtask.id === event.subtaskId)?.title || event.subtaskId,
        description: event.type === 'task_completed' ? 'Task completed.' : 'Task needs attention.',
        status: event.type === 'task_completed' ? 'completed' as const : 'needs_attention' as const,
        createdAt: existing?.createdAt || Date.now(),
        stepId: event.subtaskId,
        feedback: existing?.feedback || [],
      }
      checkpoints = existing ? checkpoints.map((item) => item.id === checkpoint.id ? checkpoint : item) : [...checkpoints, checkpoint]
    }
  }

  await persistTeamSnapshot('running')
  const access = await getConversationAccess(conversation)
  const durableMemory = await getStorage().longTermMemory.buildContext('default', {
    workspaceId: conversation.workspaceId,
    workspacePath: conversation.workspacePath || getStorage().config.get('workspacePath'),
  }, goal, 12, { enabled: getStorage().personalPreferences.getSettings().injectionEnabled })
  const teamDurableMemory = durableMemory
  const workerContexts = new Map<string, string>()
  const workerTurnMessages = new Map<string, string>()
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
    const messageMeta = { agentId: worker.id, agentName: worker.name, providerId: worker.providerId, providerName: getStorage().config.getProvider(worker.providerId)?.name || worker.providerId, model: worker.model }
    if (agentEvent.type === 'tool_call' && agentEvent.toolCall) {
      const toolCall = { ...agentEvent.toolCall }
      subtask.toolCalls = [...(subtask.toolCalls || []), toolCall]
      const timelineEntry = { id: uuidv4(), kind: 'tool' as const, timestamp: Date.now(), toolCall }
      const currentMessageId = workerTurnMessages.get(childId)
      const currentMessages = currentMessageId ? await getStorage().conversations.getMessages(childId) : []
      const currentMessage = currentMessageId ? currentMessages.find((message) => message.id === currentMessageId) : undefined
      if (currentMessage && currentMessage.role === 'assistant') {
        await getStorage().conversations.updateMessage(childId, currentMessage.id, {
          toolCalls: [...(currentMessage.toolCalls || []), toolCall],
          executionTimeline: [...(currentMessage.executionTimeline || []), timelineEntry],
        })
      } else {
        const messageId = uuidv4()
        workerTurnMessages.set(childId, messageId)
        await getStorage().conversations.addMessage(childId, {
          id: messageId, conversationId: childId, role: 'assistant', content: '', ...messageMeta,
          toolCalls: [toolCall],
          executionTimeline: [timelineEntry],
          timestamp: Date.now(),
        })
      }
      return
    }
    if (agentEvent.type === 'tool_result' && agentEvent.toolResult) {
      const toolResult = agentEvent.toolResult
      subtask.toolCalls = (subtask.toolCalls || []).map((toolCall) => toolCall.id === toolResult.toolCallId
        ? { ...toolCall, result: toolResult.result, isError: toolResult.isError, protocol: toolResult.protocol }
        : toolCall)
      const messageId = workerTurnMessages.get(childId)
      const existing = messageId ? (await getStorage().conversations.getMessages(childId)).find((message) => message.id === messageId) : undefined
      if (existing) {
        const result = compactToolResult(toolResult.result)
        await getStorage().conversations.updateMessage(childId, messageId!, {
          toolCalls: (existing.toolCalls || []).map((toolCall) => toolCall.id === toolResult.toolCallId ? { ...toolCall, result, isError: toolResult.isError, protocol: toolResult.protocol } : toolCall),
          executionTimeline: (existing.executionTimeline || []).map((entry) => {
            if (!entry.toolCall || entry.toolCall.id !== toolResult.toolCallId) return entry
            return { ...entry, toolCall: { id: entry.toolCall.id, name: entry.toolCall.name, arguments: entry.toolCall.arguments, result, isError: toolResult.isError, protocol: toolResult.protocol } }
          }),
        })
        return
      }
    }
    let content: string | undefined
    if (agentEvent.type === 'done') content = agentEvent.content || ''
    if (agentEvent.type === 'error') content = agentEvent.error ? `Error: ${agentEvent.error}` : 'Error: The worker response failed.'
    if (content === undefined) return
    const currentMessageId = workerTurnMessages.get(childId)
    const currentMessages = currentMessageId ? await getStorage().conversations.getMessages(childId) : []
    const currentMessage = currentMessageId ? currentMessages.find((message) => message.id === currentMessageId) : undefined
    if (currentMessage && currentMessage.role === 'assistant') {
      await getStorage().conversations.updateMessage(childId, currentMessage.id, {
        content,
        usage: agentEvent.type === 'done' ? agentEvent.usage : undefined,
      })
    } else {
      await getStorage().conversations.addMessage(childId, {
        id: uuidv4(), conversationId: childId, role: 'assistant', content, ...messageMeta,
        usage: agentEvent.type === 'done' ? agentEvent.usage : undefined,
        timestamp: Date.now(),
      })
    }
    workerTurnMessages.delete(childId)
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
    contextManager: new ContextManager({ durableMemory: teamDurableMemory, environmentRules: getStorage().config.get('environmentRules') }),
    workspacePath: conversationWorkspacePath(conversation, access.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath')),
    fileAccessGrants: access.fileAccessGrants,
    fullFilesystemAccess: access.fullFilesystemAccess,
    fileService: services.fileService,
    terminalService: services.terminalService,
      modelPools: getStorage().config.get('modelPools'),
          providerRegistry: services.providerRegistry,
    createWorkerConversation,
    onWorkerEvent: persistWorkerEvent,
  })
  activeDelegatedTeamOrchestrators.get(conversation.id)?.abort()
  activeDelegatedTeamOrchestrators.set(conversation.id, orchestrator)

  try {
    for await (const event of orchestrator.run({ goal, messages: historyMessages })) {
      applyTeamEvent(event)
      if (event.type === 'summary') finalSummary = event.summary || ''
      if (event.type === 'done' && event.cancelled) wasCancelled = true
      if (event.type === 'error' || event.type === 'task_failed') executionFailed = true
      if (event.type === 'done' && currentPlan) {
        currentPlan = { ...currentPlan, status: wasCancelled ? 'cancelled' : executionFailed ? 'failed' : 'completed' }
      }
      await persistTeamSnapshot(event.type === 'error' ? 'failed' : event.type === 'done' ? (event.cancelled ? 'cancelled' : 'completed') : 'running')
      if (!win.isDestroyed()) win.webContents.send(IPC.TASK_STREAM, { ...event, conversationId: conversation.id })
      if (event.type === 'error') throw new Error(event.error || 'Team orchestration failed.')
    }
    const result = wasCancelled
      ? 'The specialist team run was cancelled before completion.'
      : finalSummary || 'The specialist team completed the delegated work without a separate summary.'
    await getAgentOsScheduler().finishProcess(runtimeProcess.id, wasCancelled ? 'cancelled' : 'completed', result)
    return result
  } catch (error: any) {
    executionFailed = true
    await persistTeamSnapshot(wasCancelled ? 'cancelled' : 'failed')
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
      return { type: 'text_reset', discardProvisionalText: event.discardProvisionalText, reason: event.reason }
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
      return { type: 'done', content: event.content, finishReason: event.finishReason, usage: event.usage, timing: event.timing }
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
  const conversationLifecycle = new ConversationLifecycleService(services?.storage || getStorage())
  const symposiumExecution = services ? new SymposiumExecutionService(services) : undefined
  // ─── Conversation CRUD ──────────────────────────────────────────────────────

  ipcMain.handle(IPC.CONVERSATION_LIST, async (): Promise<Conversation[]> => {
    if (services) scheduleLegacyTitleRefresh(services)
    return conversationLifecycle.list()
  })

  ipcMain.handle(
    IPC.CONVERSATION_CREATE,
    async (
      _event,
      data: CreateConversationInput
    ): Promise<Conversation> => {
      const conversation = await conversationLifecycle.create(data)
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
    clearSessionApprovals(id)
    const conversation = await conversationLifecycle.delete(id)
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
      return conversationLifecycle.load(id)
    }
  )

  ipcMain.handle(
    IPC.CONVERSATION_UPDATE,
    async (
      event,
      id: string,
      data: UpdateConversationInput
    ): Promise<void> => {
      const conversation = await conversationLifecycle.update(id, data)

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
      await conversationLifecycle.updateMessage(conversationId, messageId, data)
    }
  )

  ipcMain.handle(
    IPC.CONVERSATION_MESSAGES_DELETE_FROM,
    async (_event, conversationId: string, messageId: string): Promise<void> => {
      await conversationLifecycle.deleteMessages(conversationId, messageId)
    }
  )

  // ─── Chat: send (fire-and-forget; events streamed via CHAT_STREAM) ──────────

  ipcMain.on(
    IPC.CHAT_SEND,
    async (event, payload: { conversationId: string; message: string; agentId?: string; images?: ChatImageAttachment[]; attachments?: ChatDocumentAttachment[]; quotedMessage?: ChatMessageReference; messageId?: string }) => {
      const { conversationId, message } = payload
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      const requestStartedAt = Date.now()
      const runToken = uuidv4()
      activeChatRunTokens.set(conversationId, runToken)
      const isCurrentRun = (): boolean => activeChatRunTokens.get(conversationId) === runToken
      // Stop an older request before loading history for this one. This keeps
      // the new request from inheriting a late response from the prior turn.
      activeRunners.get(conversationId)?.abort()
      activeTaskRunners.get(conversationId)?.abort()
      // The prior turn may be waiting on an approval card. Release it so this
      // request's own approvals are not queued behind a stale card.
      rejectAllPendingApprovalsForConversation(conversationId, 'A newer chat request superseded this approval request.')
      resolvePendingGoalConfirmation(conversationId, false)
      let runner: AgentRunner | null = null
      let runtimeProcessId: string | null = null
      let activeAgentIdentity: Pick<ChatStreamEvent, 'agentId' | 'agentName'> = {}

      const sendStreamEvent = (streamEvent: ChatStreamEvent): void => {
        if (isCurrentRun() && !win.isDestroyed()) {
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
        const memory = await getStorage().longTermMemory.buildContext('default', {
          workspaceId: conversation.workspaceId,
          workspacePath: conversation.workspacePath || getStorage().config.get('workspacePath'),
        }, message, 12, { enabled: getStorage().personalPreferences.getSettings().injectionEnabled })
        const activePlanScope = conversation.workspaceId
          ? `workspace:${conversation.workspaceId}`
          : conversation.workspacePath?.trim()
            ? `workspace-path:${conversation.workspacePath.trim().toLowerCase()}`
            : `conversation:${conversationId}`
        const durableMemory = [
          memory,
          getStorage().personalPreferences.buildCapabilityContext(),
          activePlanContext(await getStorage().activePlans.getActive(activePlanScope)),
        ]
          .filter(Boolean)
          .join('\n\n')
        // The full transcript stays available to the UI. Model context starts
        // from a bounded recent window plus durable per-conversation memory so
        // a months-long chat does not resend every historical turn.
        const historyMessages = sanitizeToolHistory(await convStore.getRecentMessages(conversationId, 80)).map((item) => ({
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
        // The renderer shows this message optimistically before the main
        // process persists it. Reuse that id so the refresh snapshot replaces
        // the optimistic row instead of rendering a second identical row.
        const userMessageId = payload.messageId?.trim() || uuidv4()
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
          // Both of these are nested objects; a shallow spread would drop the
          // shipped defaults for any key the stored entry omits (e.g. a
          // `toolApproval` saved without `timeoutMs` would lose it).
          toolApproval: { ...DEFAULT_AUTOMATION_CONFIG.toolApproval, ...storedAutomation?.toolApproval },
          sandbox: { ...DEFAULT_AUTOMATION_CONFIG.sandbox, ...storedAutomation?.sandbox },
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
                contextManager: new ContextManager({ durableMemory, environmentRules: getStorage().config.get('environmentRules') }),
                workspacePath: runnerWorkspacePath,
                fileAccessGrants: workspaceAccess.fileAccessGrants,
                fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
                fileService: services.fileService,
                terminalService: services.terminalService,
                modelPools: getStorage().config.get('modelPools'),
                providerRegistry: services.providerRegistry,
                requestToolApproval: createLocalToolApproval({
                  conversationId,
                  workspaceId: conversation.workspaceId,
                  window: win,
                  config: { ...automation.toolApproval, policy: 'safe' },
                }),
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
                contextManager: new ContextManager({ durableMemory, environmentRules: getStorage().config.get('environmentRules') }),
                workspacePath: runnerWorkspacePath,
                fileAccessGrants: workspaceAccess.fileAccessGrants,
                fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
                fileService: services.fileService,
                terminalService: services.terminalService,
          modelPools: getStorage().config.get('modelPools'),
          providerRegistry: services.providerRegistry,
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
                resourceKey: conversation.workspaceId ? `workspace:${conversation.workspaceId}` : `conversation:${conversationId}`,
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
          contextManager: new ContextManager({ durableMemory, environmentRules: getStorage().config.get('environmentRules') }),
          workspacePath: runnerWorkspacePath,
          fileAccessGrants: workspaceAccess.fileAccessGrants,
          fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
          fileService: services.fileService,
          terminalService: services.terminalService,
      modelPools: getStorage().config.get('modelPools'),
          providerRegistry: services.providerRegistry,
          eventStore: services.storage.agentRunEvents,
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
          requestToolApproval: createLocalToolApproval({
            conversationId,
            workspaceId: conversation.workspaceId,
            window: win,
            config: automation.toolApproval,
          }),
        })
        // The user can cancel while configuration and history are loading,
        // before this runner has been registered in `activeRunners`.
        if (!isCurrentRun()) return
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
        // `cancelInteractive` may have happened before startInteractive
        // finished. Do not leave that late-created process running.
        if (!isCurrentRun()) {
          runner.abort()
          await getAgentOsScheduler().cancelInteractive(conversationId)
          return
        }
        getAgentOsScheduler().attachInteractiveAbort(conversationId, runtimeProcess.id, () => runner?.abort())

        // 6. Execute the ReAct loop and stream events
        const allToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
        const allToolResults: Array<{ toolCallId: string; name: string; result: string; isError: boolean; protocol?: import('../../shared/types/execution-protocol').ExecutionEnvelope }> = []
        let lastPublicExecutionNote = ''
        let assistantContent = ''
        let assistantReasoningContent = ''
        let assistantUsage: ChatUsage | undefined
        let assistantTiming: import('../../shared/types/conversation').ResponseTiming | undefined
        let assistantFinishReason: string | undefined
        let runError: string | null = null
        // The runner emits `done` before the assistant row exists. Hold it so
        // the renderer can bind its reply row to the persisted id instead of
        // guessing by content.
        let deferredDoneEvent: AgentEvent | null = null
        // Keep only a possible partial eva-progress tag between token chunks.
        // Ordinary response text must not wait for the model's final `done`
        // event, otherwise every provider appears to be non-streaming.
        const progressProjector = new TurnProgressProjector()
        // Keep provisional model text long enough to preserve it as a progress
        // entry when the runner replaces it with a tool call.
        let provisionalAssistantContent = ''
        let latestProgressContent = ''
        // Answer-structured text written before a tool cycle. It belongs to
        // the final reply, not to the thinking/progress feed.
        const answerPrefixSegments: string[] = []
        const progressUpdates: ProgressUpdate[] = []
        const processOutput = effectiveAgentConfig.processOutput || (effectiveAgentConfig.showThinking ? 'detailed' : 'compact')
        const progressCharacterLimit = processOutput === 'detailed' ? 280 : 140
        const executionTimeline: ExecutionTimelineEntry[] = []
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
        const publishProgress = async (kind: ProgressUpdateKind, content: string, item?: number): Promise<void> => {
          if (processOutput === 'off') return
          const summaries = toProgressSummaries(kind, content, progressCharacterLimit)
          for (const summary of summaries) {
            if (!summary || summary === latestProgressContent) continue
            latestProgressContent = summary
            const progressUpdate: ProgressUpdate = {
              id: uuidv4(),
              kind,
              content: summary,
              ...(item ? { item } : {}),
              timestamp: Date.now(),
            }
            progressUpdates.push(progressUpdate)
            const progressMessage: ChatMessage = {
              id: progressUpdate.id,
              conversationId,
              role: 'assistant',
              content: summary,
              progressKind: kind,
              ...(item ? { progressItem: item } : {}),
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
                ...(item ? { progressItem: item } : {}),
              } satisfies ChatStreamEvent)
            }
          }
        }
        const streamTextDelta = async (content: string): Promise<void> => {
          for (const segment of progressProjector.feed(content)) {
            if (segment.type === 'text') {
              provisionalAssistantContent += segment.content
              send({ type: 'text', content: segment.content })
              continue
            }
            await publishProgress(segment.kind, segment.content, segment.item)
          }
        }

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
            progressProjector.discardPending()
            if (agentEvent.reason === 'protocol-repair') {
              executionTimeline.push({
                id: uuidv4(),
                kind: 'note',
                content: '检测到回复包含未执行的协议标记，已自动重组并重试。',
                timestamp: Date.now(),
              })
              emitExecutionTimeline()
            }
            // Ordinary model narration is the user-visible intermediate
            // reasoning. Promote it to separate progress cards before the
            // next tool cycle replaces the streaming surface. Raw protocol
            // markup is discarded without being shown.
            if (agentEvent.discardProvisionalText || provisionalAssistantContent.trim()) {
              if (!agentEvent.discardProvisionalText && provisionalAssistantContent.trim()) {
                if (isAnswerLikeContent(provisionalAssistantContent)) {
                  answerPrefixSegments.push(provisionalAssistantContent.trim())
                } else {
                  await publishProgress('thinking', provisionalAssistantContent)
                }
              }
              provisionalAssistantContent = ''
              assistantContent = ''
              send({ ...agentEvent, discardProvisionalText: true })
            }
            continue
          }
          if (agentEvent.type === 'thinking') {
            // Keep public execution status separate from private model
            // reasoning. Only the allow-listed lifecycle vocabulary is shown,
            // and repeated provider notices are collapsed into one row.
            if (processOutput !== 'off') {
              const publicNote = toPublicExecutionNote(agentEvent.content, allToolResults.length > 0)
              if (publicNote && publicNote !== lastPublicExecutionNote) {
                lastPublicExecutionNote = publicNote
                executionTimeline.push({ id: uuidv4(), kind: 'note', content: publicNote, timestamp: Date.now() })
                emitExecutionTimeline()
              }
            }
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
          if (agentEvent.type === 'tool_call' && agentEvent.toolCall) {
            progressProjector.discardPending()
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
            progressProjector.discardPending()
            // A stopped round never produced a final answer, so the streamed
            // text is the only copy of what the user read. Keep it for the
            // persist step instead of discarding it with the buffer.
            if (!userStoppedChatRunTokens.has(runToken)) provisionalAssistantContent = ''
            if (agentEvent.content) {
              const rawContent = agentEvent.content
              const strippedContent = stripProgressBlocks(rawContent).trim()
              // If the model wrapped its actual answer inside eva-progress tags,
              // stripping them must not produce an empty reply; keep the tag
              // contents as plain text instead.
              assistantContent = strippedContent || unwrapProgressTags(rawContent).trim()
            }
            // Reattach answer-structured sections the model wrote before tool
            // cycles so the persisted reply keeps its beginning in order.
            if (answerPrefixSegments.length > 0) {
              assistantContent = [...answerPrefixSegments, assistantContent.trim()].filter(Boolean).join('\n\n')
            }
            if (assistantContent) agentEvent.content = assistantContent
            assistantUsage = agentEvent.usage
            assistantTiming = agentEvent.timing
              ? {
                  ...agentEvent.timing,
                  localPreparationMs: Math.max(0, Date.now() - requestStartedAt - agentEvent.timing.totalMs),
                  totalMs: Date.now() - requestStartedAt,
                }
              : undefined
            if (assistantTiming) agentEvent.timing = assistantTiming
            assistantFinishReason = agentEvent.finishReason
          }
          if (agentEvent.type === 'error') {
            runError = agentEvent.error || 'The model response failed.'
          }

          // Forward event to renderer, except the terminal event: it is sent
          // once the assistant row is stored (see below).
          if (agentEvent.type === 'done') {
            deferredDoneEvent = agentEvent
          } else {
            send(agentEvent)
          }
        }

        // The request may have been replaced while the runner was awaiting a
        // provider response. Do not let stale output reach storage or update
        // the conversation status after a newer request took ownership.
        // A run the user stopped is different: its streamed text is the only
        // copy of what they were reading, so it is stored as cancelled. A run
        // superseded by a newer message stores nothing; that message owns the
        // conversation now.
        const stoppedByUser = userStoppedChatRunTokens.delete(runToken)
        if (!isCurrentRun() && !(stoppedByUser && !activeChatRunTokens.has(conversationId))) return

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

        const persistedContent = resolveAssistantTurnContent({
          completedContent: assistantContent,
          provisionalContent: provisionalAssistantContent,
          runError,
          userAborted: stoppedByUser,
        })

        const assistantChatMessage: ChatMessage = {
          id: assistantMessageId,
          conversationId,
          role: 'assistant',
          content: persistedContent,
          reasoningContent: assistantReasoningContent || undefined,
          executionTimeline: executionTimeline.length > 0 ? executionTimeline : undefined,
          progressUpdates: progressUpdates.length > 0 ? progressUpdates : undefined,
          toolCalls: toolCallsForMessage,
          agentId: effectiveAgentConfig.id,
          agentName: effectiveAgentConfig.name,
          providerId: effectiveAgentConfig.providerId,
          providerName: getStorage().config.getProvider(effectiveAgentConfig.providerId)?.name || effectiveAgentConfig.providerId,
          model: effectiveAgentConfig.model,
          usage: assistantUsage,
          timing: assistantTiming,
          finishReason: assistantFinishReason,
          timestamp: Date.now(),
        }
        await convStore.addMessage(conversationId, assistantChatMessage)
        if (deferredDoneEvent) {
          sendStreamEvent({ ...toChatStreamEvent(deferredDoneEvent), messageId: assistantMessageId })
        }
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
        // The abort handler writes `executionStatus` asynchronously, so it can
        // still read as 'running' here. The stopped-run flag is authoritative.
        const turnStatus = stoppedByUser
          ? 'cancelled'
          : latestConversation?.executionStatus === 'cancelled' ? 'cancelled' : runError ? 'failed' : 'completed'
        await getStorage().runtimeMemory.recordConversationTurn({
          conversationId,
          workspaceId: conversation.workspaceId,
          assistantMessageId,
          userRequest: message,
          outcome: assistantChatMessage.content,
          status: turnStatus,
        })
        try {
          await getStorage().projectKnowledge.recordEngineeringTurn({
            conversationId,
            assistantMessageId,
            workspaceId: conversation.workspaceId,
            workspacePath: conversation.workspacePath || getStorage().config.get('workspacePath'),
            userRequest: message,
            assistantContent: assistantChatMessage.content,
            status: turnStatus,
            toolCalls: toolCallsForMessage,
          })
        } catch (error) {
          console.warn('Project knowledge recording failed:', error)
        }
        services.memoryAgent.enqueue({
          conversationId,
          messageId: assistantMessageId,
          workspaceId: conversation.workspaceId,
          workspacePath: conversation.workspacePath || getStorage().config.get('workspacePath'),
          userRequest: message,
          assistantResult: assistantChatMessage.content,
          status: turnStatus,
          changedFiles: (toolCallsForMessage || []).flatMap((toolCall) => {
            const value = toolCall.arguments.path
            return typeof value === 'string' ? [value] : []
          }),
          toolCalls: (toolCallsForMessage || []).map((toolCall) => ({
            name: toolCall.name,
            target: typeof toolCall.arguments.path === 'string' ? toolCall.arguments.path : undefined,
            resultSummary: toolCall.result?.slice(0, 500),
            isError: toolCall.isError,
          })),
        }, effectiveAgentConfig.providerId, effectiveAgentConfig.model)
        win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
        void recordActivity({
          category: 'agent',
          action: stoppedByUser ? 'agent.cancelled' : runError ? 'agent.failed' : 'agent.completed',
          status: stoppedByUser ? 'info' : runError ? 'error' : 'success',
          summary: stoppedByUser
            ? `${effectiveAgentConfig.name}'s response was stopped by the user.`
            : runError || `${effectiveAgentConfig.name} completed the response.`,
          conversationId,
          workspaceId: conversation.workspaceId,
        }, win)
        if (runtimeProcessId) {
          await getAgentOsScheduler().finishInteractive(
            runtimeProcessId,
            turnStatus,
            stoppedByUser ? 'Stopped by the user.' : runError || `${effectiveAgentConfig.name} completed the chat request.`,
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
        if (!isCurrentRun()) return
        if (runtimeProcessId) {
          await getAgentOsScheduler().finishInteractive(runtimeProcessId, 'failed', err?.message ?? String(err))
        }
        try {
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
        if (isCurrentRun()) activeChatRunTokens.delete(conversationId)
        userStoppedChatRunTokens.delete(runToken)
      }
    }
  )

  // ─── Chat: abort ────────────────────────────────────────────────────────────

  ipcMain.on(IPC.CHAT_ABORT, (event, conversationId?: string) => {
    if (conversationId) {
      const stoppedRunToken = activeChatRunTokens.get(conversationId)
      if (stoppedRunToken) userStoppedChatRunTokens.add(stoppedRunToken)
      activeChatRunTokens.delete(conversationId)
      resolvePendingGoalConfirmation(conversationId, false)
      rejectAllPendingApprovalsForConversation(conversationId, 'The user cancelled the chat.')
      activeRunners.get(conversationId)?.abort()
      activeTaskRunners.get(conversationId)?.abort()
      activeBackgroundGoalPlanners.get(conversationId)?.abort()
      activeDelegatedTeamOrchestrators.get(conversationId)?.abort()
      symposiumExecution?.abort(conversationId)
      activeTaskRunners.delete(conversationId)
      void getAgentOsScheduler().cancelInteractive(conversationId)
      void getStorage().conversations.addMessage(conversationId, {
        id: uuidv4(),
        conversationId,
        role: 'system',
        content: '<turn_aborted>本轮执行已被用户中断。中断时正在进行的模型调用或工具调用未必完成；后续不得假设其成功。</turn_aborted>',
        timestamp: Date.now(),
      }).catch(() => undefined)
      void getAgentOsScheduler().transitionConversation(conversationId, 'goal', 'cancelled', 'Stopped by the user.')
      void getAgentOsScheduler().transitionConversation(conversationId, 'team', 'cancelled', 'Stopped by the user.')
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
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

  ipcMain.handle(
    IPC.CHAT_TOOL_APPROVAL_DECIDE,
    async (_event, payload: { conversationId?: string; approvalId?: string; approved?: boolean; rememberScope?: 'once' | 'session' }): Promise<boolean> => {
      const approvalId = typeof payload?.approvalId === 'string' ? payload.approvalId : ''
      const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : ''
      const approved = payload?.approved === true
      const rememberScope = payload?.rememberScope === 'session' ? 'session' : 'once'
      if (!approvalId) return false
      const handled = resolvePendingApproval(
        approvalId,
        approved,
        approved ? undefined : 'The user denied the tool call.',
        rememberScope,
      )
      if (!handled) return false

      void recordActivity({
        category: 'permission',
        action: approved ? 'chat.tool_approved' : 'chat.tool_rejected',
        status: approved ? 'success' : 'error',
        summary: `User ${approved ? 'approved' : 'rejected'} tool call (${rememberScope}).`,
        conversationId,
      })
      return true
    }
  )

  ipcMain.on(IPC.SYMPOSIUM_START, (event, input: SymposiumStartInput) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!symposiumExecution || !win) return
    symposiumExecution.abort(input.conversationId)
    void symposiumExecution.run(input, win)
  })

  ipcMain.on(IPC.SYMPOSIUM_CONTINUE, (event, input: SymposiumContinueInput) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!symposiumExecution || !win) return
    if (symposiumExecution.isRunning(input.conversationId)) return
    void symposiumExecution.run(input, win)
  })

  ipcMain.on(IPC.SYMPOSIUM_ABORT, (_event, conversationId: string) => {
    symposiumExecution?.abort(conversationId)
  })

  ipcMain.on(IPC.TASK_GOAL_ABORT, (_event, conversationId: string) => {
    activeBackgroundGoalPlanners.get(conversationId)?.abort()
  })
}
