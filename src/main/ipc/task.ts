import { BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import { markGoalProgressCancelled, markGoalProgressFailed, type GoalConfig, type GoalProgress, type TaskCheckpoint, type TaskFeedback, type TaskPlan, type TaskRunSnapshot, type TeamEvent } from '../../shared/types/task'
import type { AgentConfig } from '../../shared/types/agent'
import type { Conversation } from '../../shared/types/conversation'
import type { ChatMessage } from '../../shared/types/conversation'
import type { ToolRegistry, FileService, TerminalService } from '../tools'
import type { ProviderRegistry } from '../providers'
import { ContextManager } from '../agent-engine/context'
import { TeamOrchestrator } from '../agent-engine/team-orchestrator'
import { GoalPlanner } from '../agent-engine/goal-planner'
import type { GoalEvent } from '../agent-engine/goal-planner'
import { getStorage, type StorageManager } from '../storage'
import { recordActivity } from '../services/activity-log'
import { toTaskArtifactRun } from '../services/task-artifact-service'
import { getAgentOsScheduler } from '../services/agent-os-scheduler'
import { controlBackgroundGoal } from '../services/background-goal-control'
import { resolveEffectiveAgentConfig } from '../services/effective-agent-config'
import type { TaskQueueUpdate } from '../services/task-execution-queue'
import { TaskRunLifecycleService } from '../services/task-run-lifecycle-service'
import { v4 as uuidv4 } from 'uuid'
import { prepareGoalStepConversation, persistGoalStepEvent } from '../services/goal-step-conversation'
import { activeRunRegistry } from '../services/run-registry'

export interface TaskServices {
  storage: StorageManager
  toolRegistry: ToolRegistry
  providerRegistry: ProviderRegistry
  fileService: FileService
  terminalService: TerminalService
}

export interface ExpertTaskStartInput {
  conversationId: string
  goal: string
  resume?: boolean
  recoveryReason?: 'user-continue' | 'app-restart'
}

export interface GoalTaskStartInput {
  goal: string
  config?: Partial<GoalConfig>
  conversationId: string
  agentId: string
  resume?: boolean
  recoveryReason?: 'user-continue' | 'app-restart'
}

// Execution controls are keyed by conversation so separate chats can run in
// parallel without sharing a cancellation handle or status.
const activeOrchestrators = activeRunRegistry.forKind<TeamOrchestrator>('task-team')
const activeGoalPlanners = activeRunRegistry.forKind<GoalPlanner>('task-goal')
let taskServices: TaskServices | null = null
let taskLifecycle: TaskRunLifecycleService | null = null
type TaskIpcEvent = IpcMainEvent | IpcMainInvokeEvent
let startExpertTask: ((event: TaskIpcEvent, payload: ExpertTaskStartInput) => Promise<void>) | undefined
let startGoalTask: ((event: TaskIpcEvent, payload: GoalTaskStartInput) => Promise<void>) | undefined

/** Temporary compatibility seam while handlers are migrated off the legacy singleton. */
function taskStorage(): StorageManager {
  return taskServices?.storage || getStorage()
}

function taskRunLifecycle(): TaskRunLifecycleService {
  return taskLifecycle || new TaskRunLifecycleService(taskStorage())
}

/** Internal entry point for recovery and runtime actions; IPC only adapts into it. */
export async function startExpertTaskRun(event: TaskIpcEvent, payload: ExpertTaskStartInput): Promise<void> {
  if (!startExpertTask) throw new Error('Task handlers are not initialized.')
  await startExpertTask(event, payload)
}

/** Internal entry point for recovery and runtime actions; IPC only adapts into it. */
export async function startGoalTaskRun(event: TaskIpcEvent, payload: GoalTaskStartInput): Promise<void> {
  if (!startGoalTask) throw new Error('Task handlers are not initialized.')
  await startGoalTask(event, payload)
}

function notifyConversationChanged(event: TaskIpcEvent, conversationId: string): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (window && !window.isDestroyed()) window.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
}

async function resolveTaskRuntimeScope(conversationId: string): Promise<{ workspaceId?: string; resourceKey: string }> {
  return taskRunLifecycle().resolveRuntimeScope(conversationId)
}

/** Mirrors durable Goal/Team checkpoints into the workspace's visible active plan. */
async function syncActivePlan(conversationId: string): Promise<void> {
  return taskRunLifecycle().syncActivePlan(conversationId)
}

function resolveGoalAgentConnection(agentConfig: AgentConfig, services: TaskServices): { agentConfig: AgentConfig; provider: NonNullable<ReturnType<ProviderRegistry['get']>>; usedFallback: boolean } {
  const effectiveAgentConfig = resolveEffectiveAgentConfig(agentConfig, {
    providerId: taskStorage().config.get('activeProviderId'),
    model: taskStorage().config.getActiveModel(),
  })
  const configuredConnections = [
    { providerId: effectiveAgentConfig.providerId, model: effectiveAgentConfig.model },
    ...(effectiveAgentConfig.modelCandidates || []),
    ...(effectiveAgentConfig.isBuiltIn ? [] : [{
      providerId: taskStorage().config.get('activeProviderId'),
      model: taskStorage().config.getActiveModel(),
    }]),
  ]
  const seen = new Set<string>()

  for (const connection of configuredConnections) {
    const providerId = connection.providerId?.trim()
    if (!providerId || seen.has(providerId)) continue
    seen.add(providerId)
    const provider = services.providerRegistry.get(providerId)
    if (!provider) continue
    const model = connection.model?.trim() || services.providerRegistry.getDefaultModel(providerId) || effectiveAgentConfig.model
    return {
      agentConfig: providerId === effectiveAgentConfig.providerId && model === effectiveAgentConfig.model
        ? effectiveAgentConfig
        : { ...effectiveAgentConfig, providerId, model },
      provider,
      usedFallback: providerId !== effectiveAgentConfig.providerId || model !== effectiveAgentConfig.model,
    }
  }

  throw new Error(`No available model connection for Goal execution. The selected connection "${effectiveAgentConfig.providerId}" is unavailable; configure a model connection and try again.`)
}

/** Persist a user-requested stop before the planner has a chance to emit again. */
export async function cancelTaskRun(
  conversationId: string,
  kind?: 'expert' | 'goal',
): Promise<boolean> {
  if (kind !== 'expert') await controlBackgroundGoal(conversationId, 'cancel')
  const queueCancelled = await getAgentOsScheduler().cancelTask(conversationId, kind)
  const goalPlanner = kind === 'expert' ? undefined : activeGoalPlanners.get(conversationId)
  const teamOrchestrator = kind === 'goal' ? undefined : activeOrchestrators.get(conversationId)
  goalPlanner?.abort()
  teamOrchestrator?.abort()

  const snapshot = await taskStorage().taskRuns.get(conversationId)
  if (snapshot && (!kind || snapshot.kind === kind)) {
    const stoppedAt = Date.now()
    await taskStorage().taskRuns.save({
      ...snapshot,
      status: 'cancelled',
      progress: snapshot.kind === 'goal' && snapshot.progress
        ? markGoalProgressCancelled(snapshot.progress, stoppedAt)
        : snapshot.progress,
      error: undefined,
      execution: snapshot.execution
        ? { ...snapshot.execution, state: 'cancelled', lastActivityAt: stoppedAt, nextRetryAt: undefined }
        : undefined,
    })
    await taskStorage().conversations.updateConversation(conversationId, {
      executionStatus: 'cancelled',
      executionUpdatedAt: Date.now(),
    })
    await getAgentOsScheduler().transitionTask(
      conversationId,
      snapshot.kind === 'expert' ? 'team' : 'goal',
      'cancelled',
      'Stopped by the user.',
    )
    await syncActivePlan(conversationId)
  }
  return queueCancelled || Boolean(goalPlanner || teamOrchestrator || snapshot)
}

/** Allows the chat agent to control a Goal launched from the visible Goal UI. */
export async function controlForegroundGoal(
  conversationId: string,
  action: 'status' | 'pause' | 'resume' | 'cancel',
): Promise<{ handled: boolean; status?: TaskRunSnapshot['status'] }> {
  const planner = activeGoalPlanners.get(conversationId)
  const queued = getAgentOsScheduler().hasTask(conversationId, 'goal')
  const snapshot = await taskStorage().taskRuns.get(conversationId)

  if (action === 'status') {
    return { handled: Boolean(planner || queued || snapshot), status: snapshot?.status }
  }
  if (action === 'pause' && planner) {
    planner.pause()
    if (snapshot) await taskStorage().taskRuns.save({ ...snapshot, status: 'paused' })
    await taskStorage().conversations.updateConversation(conversationId, { executionStatus: 'paused', executionUpdatedAt: Date.now() })
    await getAgentOsScheduler().transitionTask(conversationId, 'goal', 'paused', 'Paused by the user.')
    return { handled: true, status: 'paused' }
  }
  if (action === 'resume' && planner) {
    planner.resume()
    if (snapshot) await taskStorage().taskRuns.save({ ...snapshot, status: 'running' })
    await taskStorage().conversations.updateConversation(conversationId, { executionStatus: 'running', executionUpdatedAt: Date.now() })
    await getAgentOsScheduler().transitionTask(conversationId, 'goal', 'running', 'Resumed by the user.')
    return { handled: true, status: 'running' }
  }
  if (action === 'cancel' && (planner || queued || snapshot)) {
    await cancelTaskRun(conversationId, 'goal')
    return { handled: true, status: 'cancelled' }
  }
  return { handled: false, status: snapshot?.status }
}

async function persistQueueUpdate(update: TaskQueueUpdate): Promise<void> {
  return taskRunLifecycle().persistQueueUpdate(update)
}

/**
 * Goal runs created before task snapshots existed are still present in the
 * conversation's persisted tool history. Rebuild a read-only snapshot once so
 * the task center does not hide the user's previous work.
 */
async function backfillLegacyGoalSnapshots(conversations: Conversation[], snapshots: TaskRunSnapshot[]): Promise<void> {
  const savedConversationIds = new Set(snapshots.map((snapshot) => snapshot.conversationId))

  // Early Goal integrations persisted only an "accepted" tool response. Those
  // records have neither scheduler metadata nor a generated plan, so they
  // cannot truthfully be shown as completed. Convert them once into an
  // interruptible/retryable task instead of hiding their original request.
  for (const snapshot of snapshots) {
    if (
      snapshot.kind === 'goal'
      && snapshot.status === 'completed'
      && !snapshot.execution
      && !snapshot.progress?.steps.length
    ) {
      await getStorage().taskRuns.save({
        ...snapshot,
        status: 'interrupted',
        error: 'This historical Goal has no durable execution plan. Retry it to create a new plan from the original request.',
      })
    }
  }

  for (const conversation of conversations) {
    if (savedConversationIds.has(conversation.id)) continue
    const messages = await getStorage().conversations.getMessages(conversation.id)
    const sourceMessage = [...messages].reverse().find((message) =>
      message.role === 'assistant' && message.toolCalls?.some((toolCall) => toolCall.name === 'run_goal')
    )
    const toolCall = sourceMessage?.toolCalls?.find((item) => item.name === 'run_goal')
    const goal = typeof toolCall?.arguments.goal === 'string' ? toolCall.arguments.goal.trim() : ''
    if (!sourceMessage || !toolCall || !goal) continue

    const result = toolCall.result
      || messages.find((message) => message.role === 'tool' && message.toolCallId === toolCall.id)?.content
      || ''
    const failed = Boolean(toolCall.isError) || /(?:timed out|task execution failed|goal execution failed)/i.test(result)
    const onlyAcknowledged = !result || /(?:accepted|queued|started|running)/i.test(result)
    const completedAt = sourceMessage.timestamp || conversation.updatedAt

    await getStorage().taskRuns.save({
      conversationId: conversation.id,
      kind: 'goal',
      status: failed ? 'failed' : onlyAcknowledged ? 'interrupted' : 'completed',
      goal,
      agentId: conversation.agentId,
      progress: {
        goal,
        steps: [],
        currentStepIndex: 0,
        totalSteps: 0,
        // GoalProgress is intentionally narrower than the durable task state:
        // an interrupted run is rendered as failed internally, while the
        // outer snapshot preserves the recoverable "interrupted" status.
        status: failed || onlyAcknowledged ? 'failed' : 'completed',
        startedAt: completedAt,
        completedAt,
        summary: result || undefined,
        conversationId: conversation.id,
      },
      summary: result || undefined,
      error: failed
        ? (result || 'This historical Goal run did not complete.')
        : onlyAcknowledged
          ? 'This historical Goal was accepted but has no durable execution plan. Retry it to create a new plan.'
          : undefined,
      checkpoints: [],
    })
  }
}

async function getConversationAccess(conversation?: Conversation | null): Promise<{ grants: import('../../shared/types/file-access').FileAccessGrant[]; fullFilesystemAccess: boolean }> {
  if (conversation?.permissionLevel) {
    if (conversation.permissionLevel === 'full-access') {
      return { grants: [], fullFilesystemAccess: true }
    }
    if (conversation.permissionLevel === 'granted-folders') {
      return { grants: conversation.fileAccessGrants || [], fullFilesystemAccess: false }
    }
    return { grants: [], fullFilesystemAccess: false }
  }

  if (conversation?.accessScope === 'full') {
    return { grants: [], fullFilesystemAccess: true }
  }
  if (conversation?.workspacePath) {
    return { grants: [], fullFilesystemAccess: false }
  }
  return { grants: getStorage().config.get('fileAccessGrants'), fullFilesystemAccess: false }
}

function conversationWorkspacePath(conversation: Conversation, fallback = ''): string {
  return conversation.workspaceId ? (conversation.workspacePath || fallback) : ''
}

function applyGoalEventToSnapshot(current: GoalProgress | null, event: GoalEvent, conversationId: string): GoalProgress | null {
  switch (event.type) {
    case 'goal_started':
      // A resumed run emits this event too. Keep its persisted plan and completed
      // steps instead of treating it as a brand new execution.
      return current
        ? { ...current, goal: event.goal, status: 'in_progress', completedAt: undefined, conversationId }
        : { goal: event.goal, steps: [], currentStepIndex: 0, totalSteps: 0, status: 'in_progress', startedAt: Date.now(), conversationId }
    case 'plan_created':
      return current ? { ...current, steps: event.steps, totalSteps: event.steps.length } : current
    case 'step_started':
      return current ? { ...current, currentStepIndex: event.stepIndex, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, status: 'in_progress', startedAt: Date.now(), attempt: event.attempt, maxAttempts: event.maxAttempts, attempts: event.attempts, ...(event.agentConversationId ? { agentConversationId: event.agentConversationId } : {}) } : step) } : current
    case 'step_conversation':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, agentConversationId: event.agentConversationId, handoff: event.handoff } : step) } : current
    case 'step_tool_call':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, toolCalls: [...(step.toolCalls || []), event.toolCall] } : step) } : current
    case 'step_tool_result':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, toolCalls: (step.toolCalls || []).map((call) => call.id === event.toolCallId ? { ...call, result: event.result, isError: event.isError } : call) } : step) } : current
    case 'step_retrying':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, status: 'in_progress', attempt: event.attempt, maxAttempts: event.maxAttempts, attempts: event.attempts, result: undefined } : step) } : current
    case 'step_completed':
    case 'step_failed':
      return current ? { ...current, steps: current.steps.map((step) => step.id === event.stepId ? { ...step, status: event.type === 'step_completed' ? 'completed' : 'failed', result: event.type === 'step_completed' ? event.result : event.error, attempts: event.attempts || step.attempts, completedAt: Date.now() } : step) } : current
    case 'plan_adjusted':
      return current ? { ...current, steps: [...current.steps.filter((step) => step.status === 'completed' || step.status === 'failed'), ...event.steps], totalSteps: event.steps.length } : current
    case 'summary':
      return current ? { ...current, summary: event.content } : current
    case 'done':
      return { ...event.progress, conversationId }
    default:
      return current
  }
}

function upsertCheckpoint(
  checkpoints: TaskCheckpoint[],
  checkpoint: Omit<TaskCheckpoint, 'feedback'>,
): TaskCheckpoint[] {
  const existing = checkpoints.find((item) => item.id === checkpoint.id)
  if (existing) {
    return checkpoints.map((item) => item.id === checkpoint.id ? { ...item, ...checkpoint, feedback: item.feedback } : item)
  }
  return [...checkpoints, { ...checkpoint, feedback: [] }]
}

function checkpointForTeamEvent(event: TeamEvent): Omit<TaskCheckpoint, 'feedback'> | null {
  if (event.type === 'plan_created' && event.plan) {
    return {
      id: 'plan-created',
      title: 'Execution plan created',
      description: `${event.plan.subtasks.length} tasks ready for execution.`,
      status: 'recorded',
      createdAt: Date.now(),
    }
  }
  if ((event.type === 'task_completed' || event.type === 'task_failed') && event.subtask) {
    return {
      id: `team-${event.subtask.id}`,
      title: event.subtask.title,
      description: event.type === 'task_completed' ? 'Task completed.' : 'Task needs attention.',
      status: event.type === 'task_completed' ? 'completed' : 'needs_attention',
      createdAt: Date.now(),
      stepId: event.subtask.id,
    }
  }
  return null
}

function checkpointForGoalEvent(event: GoalEvent): Omit<TaskCheckpoint, 'feedback'> | null {
  if (event.type === 'plan_created') {
    return {
      id: 'plan-created',
      title: 'Execution plan created',
      description: `${event.steps.length} steps ready for execution.`,
      status: 'recorded',
      createdAt: Date.now(),
    }
  }
  if (event.type === 'step_completed' || event.type === 'step_failed') {
    return {
      id: `goal-${event.stepId}`,
      title: `Step ${event.stepId.replace(/^step-/, '')}`,
      description: event.type === 'step_completed' ? 'Step completed.' : 'Step needs attention.',
      status: event.type === 'step_completed' ? 'completed' : 'needs_attention',
      createdAt: Date.now(),
      stepId: event.stepId,
    }
  }
  return null
}

export function registerTaskHandlers(services?: TaskServices): void {
  if (services) {
    taskServices = services
    taskLifecycle = new TaskRunLifecycleService(services.storage)
  }

  const scheduler = getAgentOsScheduler()
  scheduler.registerRecoveryHandler('team', async (run, context) => {
    const window = context as BrowserWindow
    const goal = run.payload?.goal
    if (!goal || !window || window.isDestroyed()) return false
    await startExpertTaskRun({ sender: window.webContents } as IpcMainEvent, {
      conversationId: run.conversationId,
      goal,
      resume: run.payload?.resume ?? false,
      recoveryReason: 'app-restart',
    })
    return true
  })
  scheduler.registerRecoveryHandler('goal', async (run, context) => {
    const window = context as BrowserWindow
    const goal = run.payload?.goal
    const agentId = run.payload?.agentId
    if (!goal || !agentId || !window || window.isDestroyed()) return false
    await startGoalTaskRun({ sender: window.webContents } as IpcMainEvent, {
      conversationId: run.conversationId,
      goal,
      agentId,
      resume: run.payload?.resume ?? false,
      recoveryReason: 'app-restart',
      config: run.payload?.config,
    })
    return true
  })

  // ─── Expert Mode ────────────────────────────────────────────────────────────

  // Expert mode - start task (fire-and-forget; events streamed via TASK_STREAM)
  startExpertTask = async (event: TaskIpcEvent, payload: ExpertTaskStartInput): Promise<void> => {
      const { conversationId, goal } = payload
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      if (getAgentOsScheduler().hasTask(conversationId, 'expert')) return
      const runtimeScope = await resolveTaskRuntimeScope(conversationId)
      const previousSnapshot = payload.resume ? await getStorage().taskRuns.get(conversationId) : null
      const recovery = payload.resume
        ? { replayCount: (previousSnapshot?.recovery?.replayCount || 0) + 1, lastReplayAt: Date.now(), reason: payload.recoveryReason || 'user-continue' as const }
        : undefined
      await getStorage().taskRuns.save({
        conversationId,
        kind: 'expert',
        status: 'queued',
        goal,
        plan: previousSnapshot?.plan,
        checkpoints: previousSnapshot?.checkpoints || [],
        recovery,
        execution: { state: 'queued', attempt: 0, maxAttempts: 2, queuedAt: Date.now(), lastActivityAt: Date.now() },
      })
      await syncActivePlan(conversationId)
      await getStorage().conversations.updateConversation(conversationId, { executionStatus: 'running', executionUpdatedAt: Date.now() })
      win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)

      await getAgentOsScheduler().scheduleTask({
        conversationId,
        kind: 'expert',
        runtimeKind: 'team',
        workspaceId: runtimeScope.workspaceId,
        maxAttempts: 2,
        resourceKey: runtimeScope.resourceKey,
        summary: payload.resume ? 'Replaying Expert Team task from its saved checkpoint.' : 'Expert Team task queued.',
        recoveryPayload: { goal, resume: Boolean(previousSnapshot?.plan?.subtasks.length), recoveryReason: 'app-restart' },
        onUpdate: async (update) => {
          await persistQueueUpdate(update)
          if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
        },
        run: async (attempt) => {
          if (attempt > 1) payload.resume = true
          let orchestrator: TeamOrchestrator | null = null
          let currentPlan: TaskPlan | undefined
          let checkpoints: TaskCheckpoint[] = []

          const send = (teamEvent: TeamEvent): void => {
            if (!win.isDestroyed()) {
              win.webContents.send(IPC.TASK_STREAM, { ...teamEvent, conversationId })
            }
          }

          if (!taskServices) {
            const error = 'Task services not initialized'
            send({ type: 'error', error })
            send({ type: 'done' })
            return { status: 'failed' as const, error, retryable: false }
          }
          const activeTaskServices = taskServices

          try {
        const previousSnapshot = payload.resume ? await getStorage().taskRuns.get(conversationId) : null
        if (payload.resume && (!previousSnapshot || previousSnapshot.kind !== 'expert' || !previousSnapshot.plan)) {
          throw new Error('This Team task has no saved plan to resume.')
        }
        currentPlan = previousSnapshot?.plan
        checkpoints = previousSnapshot?.checkpoints || []
        await getStorage().taskRuns.save({
          conversationId,
          kind: 'expert',
          status: 'running',
          plan: currentPlan,
          checkpoints,
        })
        // 1. Load agents
        const agentStore = getStorage().agents
        const allAgents = await agentStore.listAgents()

        const leader = allAgents.find((a: AgentConfig) => a.role === 'leader')
        if (!leader) {
          throw new Error('No leader agent found. Please create a leader agent first.')
        }

        const workers = allAgents.filter(
          (a: AgentConfig) =>
            a.role !== 'leader' &&
            ['researcher', 'coder', 'reviewer', 'tester'].includes(a.role)
        )

        // 2. Validate the leader connection. Workers resolve their own connections
        // so that a team can deliberately use different models for different roles.
        const leaderConnections = [
          ...(leader.modelCandidates || []),
          { providerId: leader.providerId, model: leader.model },
          ...(leader.isBuiltIn ? [{ providerId: getStorage().config.get('activeProviderId'), model: getStorage().config.getActiveModel() }] : []),
        ]
        if (!leaderConnections.some((connection) => activeTaskServices.providerRegistry.get(connection.providerId))) {
          throw new Error('No model connection for Team Leader is available. Configure its model access first.')
        }

        // 3. Load conversation for workspace path
        const conversation = await getStorage().conversations.getConversation(conversationId)
        if (!conversation) {
          throw new Error('Conversation not found.')
        }
        const durableMemory = await getStorage().runtimeMemory.buildContext(conversationId, conversation.workspaceId)
        const workspaceAccess = await getConversationAccess(conversation)
        const workspacePath = conversationWorkspacePath(conversation, workspaceAccess.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath'))
        const historyMessages = await getStorage().conversations.getMessages(conversationId, { limit: 12 })

        // Team work belongs to the same conversation as normal chat. Persist the
        // goal immediately so it remains available after switching modes or restart.
        if (!payload.resume) {
          const goalMessage: ChatMessage = {
            id: uuidv4(),
            conversationId,
            role: 'user',
            content: goal,
            timestamp: Date.now(),
          }
          await getStorage().conversations.addMessage(conversationId, goalMessage)
          win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
        }

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
            parentConversationId: conversationId,
            teamTaskId: subtask.id,
          })
          workerContexts.set(subtask.id, child.id)
          await getStorage().conversations.addMessage(child.id, {
            id: uuidv4(),
            conversationId: child.id,
            role: 'user',
            content: `Team assignment\n\nTask: ${subtask.title}\n\nResponsibility: ${subtask.description}\n\nRole: ${subtask.assignedRole || worker.role}\nModel: ${worker.providerId} / ${worker.model}\n\nThis is an isolated worker context. Report concrete findings and completed work back to the team leader.`,
            timestamp: Date.now(),
          })
          win.webContents.send(IPC.CONVERSATION_CHANGED, child.id)
          return child.id
        }

        const persistWorkerEvent = async (
          subtask: import('../../shared/types/task').SubTask,
          worker: AgentConfig,
          agentEvent: import('../../shared/types/agent').AgentEvent,
        ): Promise<void> => {
          if (agentEvent.type === 'text' || agentEvent.type === 'thinking') return
          const childId = subtask.agentConversationId || workerContexts.get(subtask.id)
          if (!childId) return

          let content = ''
          let role: ChatMessage['role'] = 'assistant'
          if (agentEvent.type === 'tool_call' && agentEvent.toolCall) {
            subtask.toolCalls = [...(subtask.toolCalls || []), { ...agentEvent.toolCall }]
            content = `Calling tool: ${agentEvent.toolCall.name}`
          }
          if (agentEvent.type === 'tool_result' && agentEvent.toolResult) {
            role = 'tool'
            subtask.toolCalls = (subtask.toolCalls || []).map((toolCall) => toolCall.id === agentEvent.toolResult?.toolCallId
              ? { ...toolCall, result: agentEvent.toolResult.result, isError: agentEvent.toolResult.isError }
              : toolCall)
            const result = agentEvent.toolResult.result
            content = `${agentEvent.toolResult.name}: ${result.length > 8000 ? `${result.slice(0, 8000)}\n\n[Output truncated in worker history]` : result}`
          }
          if (agentEvent.type === 'done' && agentEvent.content) content = agentEvent.content
          if (agentEvent.type === 'error' && agentEvent.error) content = `Error: ${agentEvent.error}`
          if (!content) return

          await getStorage().conversations.addMessage(childId, {
            id: uuidv4(),
            conversationId: childId,
            role,
            content,
            agentId: worker.id,
            agentName: worker.name,
            providerId: worker.providerId,
            providerName: getStorage().config.getProvider(worker.providerId)?.name || worker.providerId,
            model: worker.model,
            usage: agentEvent.type === 'done' ? agentEvent.usage : undefined,
            timestamp: Date.now(),
          })
          if (agentEvent.type === 'done' || agentEvent.type === 'error') {
            win.webContents.send(IPC.CONVERSATION_CHANGED, childId)
          }
        }

        // 4. Create TeamOrchestrator
        orchestrator = new TeamOrchestrator({
          conversationId,
          leader,
          workers,
          providerForAgent: (agent) => taskServices?.providerRegistry.get(agent.providerId),
          fallbackModel: { providerId: getStorage().config.get('activeProviderId'), model: getStorage().config.getActiveModel() },
          toolRegistry: activeTaskServices.toolRegistry,
          contextManager: new ContextManager({ durableMemory, environmentRules: getStorage().config.get('environmentRules') }),
          workspacePath,
          fileAccessGrants: workspaceAccess.grants,
          fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
          fileService: activeTaskServices.fileService,
          terminalService: activeTaskServices.terminalService,
      modelPools: getStorage().config.get('modelPools'),
      providerRegistry: activeTaskServices.providerRegistry,
          createWorkerConversation,
          onWorkerEvent: persistWorkerEvent,
        })
        activeOrchestrators.get(conversationId)?.abort()
        activeOrchestrators.set(conversationId, orchestrator)
        for (const feedback of checkpoints.flatMap((checkpoint) => checkpoint.feedback)) {
          orchestrator.addFeedback(feedback.content)
        }
        void recordActivity({
          category: 'agent',
          action: 'team.started',
          status: 'info',
          summary: 'Expert Team started a task.',
          conversationId,
          workspaceId: conversation?.workspaceId,
        }, win)

        // 5. Execute and stream events
        let finalSummary: string | undefined
        let wasCancelled = false
        let executionFailed = false
        for await (const teamEvent of orchestrator.run({ goal, messages: historyMessages, plan: currentPlan })) {
          if (teamEvent.type === 'plan_created') currentPlan = teamEvent.plan
          if (teamEvent.type === 'summary') finalSummary = teamEvent.summary
          if (teamEvent.type === 'done' && teamEvent.cancelled) wasCancelled = true
          if (teamEvent.type === 'error') executionFailed = true
          const checkpoint = checkpointForTeamEvent(teamEvent)
          if (checkpoint) checkpoints = upsertCheckpoint(checkpoints, checkpoint)
          if (teamEvent.type === 'plan_created') {
            void recordActivity({ category: 'agent', action: 'team.planned', status: 'success', summary: `Expert Team created a plan with ${teamEvent.plan?.subtasks.length || 0} tasks.`, conversationId, workspaceId: conversation?.workspaceId }, win)
          } else if (teamEvent.type === 'task_assigned') {
            void recordActivity({ category: 'agent', action: 'team.assigned', status: 'info', summary: `${teamEvent.agentName || 'An agent'} was assigned a task.`, conversationId, workspaceId: conversation?.workspaceId }, win)
          } else if (teamEvent.type === 'task_completed') {
            void recordActivity({ category: 'agent', action: 'team.task_completed', status: 'success', summary: `${teamEvent.agentName || 'An agent'} completed a task.`, conversationId, workspaceId: conversation?.workspaceId }, win)
          } else if (teamEvent.type === 'task_failed' || teamEvent.type === 'error') {
            void recordActivity({ category: 'agent', action: 'team.task_failed', status: 'error', summary: `${teamEvent.agentName || 'An agent'} failed a task.`, conversationId, workspaceId: conversation?.workspaceId }, win)
          } else if (teamEvent.type === 'done') {
            void recordActivity({ category: 'agent', action: 'team.completed', status: 'success', summary: 'Expert Team completed the task.', conversationId, workspaceId: conversation?.workspaceId }, win)
          }
          if (currentPlan) {
            await getStorage().taskRuns.save({
              conversationId,
              kind: 'expert',
              status: orchestrator?.paused ? 'paused' : 'running',
              plan: currentPlan,
              summary: finalSummary,
              checkpoints,
            })
            await syncActivePlan(conversationId)
          }
          send(teamEvent)
        }

        if (finalSummary && !wasCancelled && !executionFailed) {
          await getStorage().conversations.addMessage(conversationId, {
            id: uuidv4(),
            conversationId,
            role: 'assistant',
            content: finalSummary,
            agentId: leader.id,
            agentName: leader.name,
            timestamp: Date.now(),
          })
          win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
        }
        if (currentPlan) currentPlan.status = wasCancelled ? 'cancelled' : executionFailed ? 'failed' : 'completed'
        await getStorage().taskRuns.save({
          conversationId,
          kind: 'expert',
          status: wasCancelled ? 'cancelled' : executionFailed ? 'failed' : 'completed',
          plan: currentPlan,
          summary: finalSummary,
          checkpoints,
        })
        await syncActivePlan(conversationId)
        await getAgentOsScheduler().transitionTask(
          conversationId,
          'team',
          wasCancelled ? 'cancelled' : executionFailed ? 'failed' : 'completed',
          finalSummary || (wasCancelled ? 'Team task was cancelled.' : executionFailed ? 'Team task failed.' : 'Team task completed.'),
        )
        await getStorage().runtimeMemory.recordTaskOutcome({
          conversationId,
          workspaceId: conversation.workspaceId,
          kind: 'team',
          goal,
          summary: finalSummary,
          status: wasCancelled ? 'cancelled' : executionFailed ? 'failed' : 'completed',
          updatedAt: Date.now(),
        })
      } catch (err: any) {
        await getStorage().taskRuns.save({
          conversationId,
          kind: 'expert',
          status: 'failed',
          plan: currentPlan,
          error: err?.message ?? String(err),
          checkpoints,
        })
        await syncActivePlan(conversationId)
        await getAgentOsScheduler().transitionTask(conversationId, 'team', 'failed', err?.message ?? String(err))
        void recordActivity({ category: 'agent', action: 'team.failed', status: 'error', summary: 'Expert Team task failed.', conversationId }, win)
        send({ type: 'error', error: err?.message ?? String(err) })
        send({ type: 'done' })
          } finally {
            if (orchestrator && activeOrchestrators.get(conversationId) === orchestrator) {
              activeOrchestrators.delete(conversationId)
            }
          }
          const snapshot = await getStorage().taskRuns.get(conversationId)
          return {
            status: snapshot?.status === 'cancelled' ? 'cancelled' as const : snapshot?.status === 'failed' ? 'failed' as const : 'completed' as const,
            error: snapshot?.error,
          }
        }
      })
  }
  ipcMain.on(IPC.TASK_START, (event, payload: ExpertTaskStartInput) => {
    void startExpertTaskRun(event, payload)
  })

  // Expert mode - abort
  ipcMain.on(IPC.TASK_ABORT, (event, conversationId: string) => {
    void cancelTaskRun(conversationId, 'expert').then(() => notifyConversationChanged(event, conversationId))
  })

  ipcMain.handle(IPC.TASK_CANCEL, async (event, conversationId: string): Promise<boolean> => {
    const cancelled = await cancelTaskRun(conversationId)
    notifyConversationChanged(event, conversationId)
    return cancelled
  })

  // Expert mode - status
  ipcMain.handle(IPC.TASK_STATUS, async (_event, conversationId: string): Promise<string> => {
    return activeOrchestrators.has(conversationId) ? 'running' : 'idle'
  })

  ipcMain.handle(IPC.TASK_SNAPSHOT, async (_event, conversationId: string) => {
    return getStorage().taskRuns.get(conversationId)
  })

  ipcMain.handle(IPC.TASK_ARTIFACTS_LIST, async (_event, workspaceId: string) => {
    const [initialSnapshots, conversations, workspace] = await Promise.all([
      getStorage().taskRuns.list(),
      getStorage().conversations.listConversations(),
      getStorage().workspaces.get(workspaceId),
    ])
    await backfillLegacyGoalSnapshots(conversations, initialSnapshots)
    const snapshots = await getStorage().taskRuns.list()
    const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]))
    return snapshots.flatMap((snapshot) => {
      const conversation = conversationsById.get(snapshot.conversationId)
      const belongsToWorkspace = conversation && (
        conversation.workspaceId === workspaceId
        || (!conversation.workspaceId && workspace && conversation.workspacePath === workspace.path)
      )
      if (!conversation || !belongsToWorkspace) return []
      return [toTaskArtifactRun(snapshot, conversation)]
    })
  })

  ipcMain.handle(IPC.TASK_FEEDBACK_ADD, async (event, payload: { conversationId: string; content: string; checkpointId?: string; pauseAfterCurrentOperation?: boolean }): Promise<TaskFeedback> => {
    const content = payload.content.trim()
    if (!content) throw new Error('A task reply cannot be empty.')
    if (content.length > 4000) throw new Error('A task reply must be 4,000 characters or fewer.')
    const snapshot = await getStorage().taskRuns.get(payload.conversationId)
    if (!snapshot) throw new Error('No task run exists for this conversation.')

    const feedback: TaskFeedback = { id: uuidv4(), content, createdAt: Date.now(), checkpointId: payload.checkpointId }
    const checkpointId = payload.checkpointId || 'user-guidance'
    const existingCheckpoints = snapshot.checkpoints || []
    const checkpoints = (existingCheckpoints.some((checkpoint) => checkpoint.id === checkpointId)
      ? existingCheckpoints
      : upsertCheckpoint(existingCheckpoints, {
        id: checkpointId,
        title: 'User guidance',
        description: 'Guidance added while the task is in progress.',
        status: 'recorded',
        createdAt: Date.now(),
      })
    ).map((checkpoint) => checkpoint.id === checkpointId ? { ...checkpoint, feedback: [...checkpoint.feedback, feedback] } : checkpoint)

    const goalPlanner = activeGoalPlanners.get(payload.conversationId)
    const teamOrchestrator = activeOrchestrators.get(payload.conversationId)
    goalPlanner?.addFeedback(content)
    teamOrchestrator?.addFeedback(content)
    if (payload.pauseAfterCurrentOperation) {
      goalPlanner?.pause()
      teamOrchestrator?.pause()
    }
    await getStorage().taskRuns.save({
      ...snapshot,
      status: payload.pauseAfterCurrentOperation && (goalPlanner || teamOrchestrator) ? 'paused' : snapshot.status,
      checkpoints,
    })
    if (payload.pauseAfterCurrentOperation && (goalPlanner || teamOrchestrator)) {
      await getStorage().conversations.updateConversation(payload.conversationId, { executionStatus: 'paused', executionUpdatedAt: Date.now() })
      notifyConversationChanged(event, payload.conversationId)
    }
    return feedback
  })

  ipcMain.handle(IPC.TASK_CHECKPOINT_RESUME, async (event, conversationId: string): Promise<boolean> => {
    const goalPlanner = activeGoalPlanners.get(conversationId)
    const teamOrchestrator = activeOrchestrators.get(conversationId)
    const resumedInProcess = Boolean(goalPlanner || teamOrchestrator)
    goalPlanner?.resume()
    teamOrchestrator?.resume()
    const snapshot = await getStorage().taskRuns.get(conversationId)
    if (snapshot?.status === 'paused' && resumedInProcess) {
      await getStorage().taskRuns.save({ ...snapshot, status: 'running' })
      await getStorage().conversations.updateConversation(conversationId, { executionStatus: 'running', executionUpdatedAt: Date.now() })
      notifyConversationChanged(event, conversationId)
    }
    return resumedInProcess
  })

  // ─── Goal Mode ──────────────────────────────────────────────────────────────

  // Goal mode - start (fire-and-forget; events streamed via TASK_GOAL_STREAM)
  startGoalTask = async (event: TaskIpcEvent, payload: GoalTaskStartInput): Promise<void> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      if (getAgentOsScheduler().hasTask(payload.conversationId, 'goal')) return
      const runtimeScope = await resolveTaskRuntimeScope(payload.conversationId)
      const previousSnapshot = payload.resume ? await getStorage().taskRuns.get(payload.conversationId) : null
      const recovery = payload.resume
        ? { replayCount: (previousSnapshot?.recovery?.replayCount || 0) + 1, lastReplayAt: Date.now(), reason: payload.recoveryReason || 'user-continue' as const }
        : undefined
      await getStorage().taskRuns.save({
        conversationId: payload.conversationId,
        kind: 'goal',
        status: 'queued',
        goal: payload.goal,
        agentId: payload.agentId,
        progress: previousSnapshot?.progress,
        checkpoints: previousSnapshot?.checkpoints || [],
        recovery,
        execution: { state: 'queued', attempt: 0, maxAttempts: 2, queuedAt: Date.now(), lastActivityAt: Date.now() },
      })
      await syncActivePlan(payload.conversationId)
      await getStorage().conversations.updateConversation(payload.conversationId, { executionStatus: 'running', executionUpdatedAt: Date.now() })
      win.webContents.send(IPC.CONVERSATION_CHANGED, payload.conversationId)

      await getAgentOsScheduler().scheduleTask({
        conversationId: payload.conversationId,
        kind: 'goal',
        runtimeKind: 'goal',
        agentId: payload.agentId,
        workspaceId: runtimeScope.workspaceId,
        maxAttempts: 2,
        resourceKey: runtimeScope.resourceKey,
        summary: payload.resume ? 'Replaying Goal task from its saved checkpoint.' : 'Goal task queued.',
        recoveryPayload: {
          goal: payload.goal,
          agentId: payload.agentId,
          resume: Boolean(previousSnapshot?.progress?.steps.length),
          recoveryReason: 'app-restart',
          config: payload.config,
        },
        onUpdate: async (update) => {
          await persistQueueUpdate(update)
          if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, payload.conversationId)
        },
        run: async (attempt) => {
          if (attempt > 1) payload.resume = true
          let planner: GoalPlanner | null = null
          let persistedProgress: GoalProgress | null = null
          let checkpoints: TaskCheckpoint[] = []

          const send = (goalEvent: GoalEvent): void => {
            if (!win.isDestroyed()) {
              win.webContents.send(IPC.TASK_GOAL_STREAM, { ...goalEvent, conversationId: payload.conversationId })
            }
          }

          try {
            if (!taskServices) throw new Error('Task services not initialized')
            const activeTaskServices = taskServices
            const previousSnapshot = payload.resume ? await getStorage().taskRuns.get(payload.conversationId) : null
        if (payload.resume && (!previousSnapshot || previousSnapshot.kind !== 'goal' || !previousSnapshot.progress)) {
          throw new Error('This Goal task has no saved progress to resume.')
        }
        persistedProgress = previousSnapshot?.progress || null
        checkpoints = previousSnapshot?.checkpoints || []
        await getStorage().taskRuns.save({
          conversationId: payload.conversationId,
          kind: 'goal',
          status: 'running',
          progress: persistedProgress || undefined,
          checkpoints,
        })

        // 1. Load agent config
        const agentConfig = await getStorage().agents.getAgent(payload.agentId)
        if (!agentConfig) {
          throw new Error(`Agent ${payload.agentId} not found`)
        }

        // 2. Resolve the same effective model used by the parent conversation.
        // Candidates are only considered when that connection is unavailable.
        const resolvedConnection = resolveGoalAgentConnection(agentConfig, activeTaskServices)
        const goalAgentConfig = resolvedConnection.agentConfig
        const provider = resolvedConnection.provider
        if (resolvedConnection.usedFallback) {
          void recordActivity({
            category: 'agent',
            action: 'goal.model_fallback',
            status: 'info',
            summary: `Goal resumed with ${goalAgentConfig.providerId} / ${goalAgentConfig.model} because the selected connection is unavailable.`,
            conversationId: payload.conversationId,
          }, win)
        }

        // 3. Get workspace path from conversation or config
        let conversation: Conversation | null = null
        if (payload.conversationId) {
          conversation = await getStorage().conversations.getConversation(payload.conversationId)
        }
        if (!conversation) throw new Error('The Goal conversation is unavailable.')
        const workspaceAccess = await getConversationAccess(conversation)
        const workspacePath = conversationWorkspacePath(conversation, workspaceAccess.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath') as string)
        const durableMemory = await getStorage().runtimeMemory.buildContext(payload.conversationId, conversation?.workspaceId)

        // 4. Create GoalPlanner
        const goalConfig: GoalConfig = {
          goal: payload.goal,
          maxSteps: payload.config?.maxSteps ?? 15,
          timeout: payload.config?.timeout ?? 30 * 60 * 1000,
          autoAdjust: payload.config?.autoAdjust ?? true,
        }

        planner = new GoalPlanner({
          conversationId: payload.conversationId,
          agentConfig: goalAgentConfig,
          provider,
          toolRegistry: activeTaskServices.toolRegistry,
          contextManager: new ContextManager({ durableMemory, environmentRules: getStorage().config.get('environmentRules') }),
          workspacePath,
          fileAccessGrants: workspaceAccess.grants,
          fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
          fileService: activeTaskServices.fileService,
          terminalService: activeTaskServices.terminalService,
      modelPools: getStorage().config.get('modelPools'),
      providerRegistry: activeTaskServices.providerRegistry,
          maxSteps: goalConfig.maxSteps,
          timeout: goalConfig.timeout,
          prepareStepConversation: async ({ step, handoff }) => {
            if (!conversation) throw new Error('Parent Goal conversation not found.')
            const prepared = await prepareGoalStepConversation({ parent: conversation, agentConfig: goalAgentConfig, workspacePath, step, handoff })
            if (!win.isDestroyed()) win.webContents.send(IPC.CONVERSATION_CHANGED, prepared.conversationId)
            return prepared
          },
          persistStepEvent: ({ step, conversationId: stepConversationId, event }) => persistGoalStepEvent({ step, conversationId: stepConversationId, event, agentConfig: goalAgentConfig }),
        })
        activeGoalPlanners.get(payload.conversationId)?.abort()
        activeGoalPlanners.set(payload.conversationId, planner)
        for (const feedback of checkpoints.flatMap((checkpoint) => checkpoint.feedback)) {
          planner.addFeedback(feedback.content)
        }
        void recordActivity({
          category: 'agent',
          action: 'goal.started',
          status: 'info',
          summary: `${agentConfig.name} started a goal-driven task.`,
          conversationId: payload.conversationId,
          workspaceId: conversation?.workspaceId,
        }, win)

        // 5. Execute and stream events
        for await (const goalEvent of planner.run(goalConfig, persistedProgress || undefined)) {
          persistedProgress = applyGoalEventToSnapshot(persistedProgress, goalEvent, payload.conversationId)
          const checkpoint = checkpointForGoalEvent(goalEvent)
          if (checkpoint) checkpoints = upsertCheckpoint(checkpoints, checkpoint)
          if (goalEvent.type === 'plan_created') {
            void recordActivity({ category: 'agent', action: 'goal.planned', status: 'success', summary: `Created a goal plan with ${goalEvent.steps.length} steps.`, conversationId: payload.conversationId, workspaceId: conversation?.workspaceId }, win)
          } else if (goalEvent.type === 'step_started') {
            void recordActivity({ category: 'agent', action: 'goal.step_started', status: 'info', summary: `Started goal step ${goalEvent.stepIndex + 1}.`, conversationId: payload.conversationId, workspaceId: conversation?.workspaceId }, win)
          } else if (goalEvent.type === 'step_completed') {
            void recordActivity({ category: 'agent', action: 'goal.step_completed', status: 'success', summary: 'Completed a goal step.', conversationId: payload.conversationId, workspaceId: conversation?.workspaceId }, win)
          } else if (goalEvent.type === 'step_failed' || goalEvent.type === 'error') {
            void recordActivity({ category: 'agent', action: 'goal.step_failed', status: 'error', summary: 'A goal step failed.', conversationId: payload.conversationId, workspaceId: conversation?.workspaceId }, win)
          } else if (goalEvent.type === 'done') {
            void recordActivity({ category: 'agent', action: 'goal.completed', status: 'success', summary: 'Goal-driven task completed.', conversationId: payload.conversationId, workspaceId: conversation?.workspaceId }, win)
          }
          await getStorage().taskRuns.save({
            conversationId: payload.conversationId,
            kind: 'goal',
            status: planner?.paused ? 'paused' : goalEvent.type === 'done'
              ? (goalEvent.progress.status === 'completed' ? 'completed' : goalEvent.progress.status === 'cancelled' ? 'cancelled' : 'failed')
              : goalEvent.type === 'error' ? 'failed' : 'running',
            progress: persistedProgress || undefined,
            summary: goalEvent.type === 'summary' ? goalEvent.content : persistedProgress?.summary,
            error: goalEvent.type === 'error' ? goalEvent.error : undefined,
            checkpoints,
          })
          await syncActivePlan(payload.conversationId)
          if (goalEvent.type === 'done') {
            const status = goalEvent.progress.status === 'completed'
              ? 'completed'
              : goalEvent.progress.status === 'cancelled'
                ? 'cancelled'
                : 'failed'
            await getAgentOsScheduler().transitionTask(
              payload.conversationId,
              'goal',
              status,
              goalEvent.progress.summary || (status === 'completed' ? 'Goal task completed.' : 'Goal task did not complete.'),
            )
            await getStorage().runtimeMemory.recordTaskOutcome({
              conversationId: payload.conversationId,
              workspaceId: conversation?.workspaceId,
              kind: 'goal',
              goal: payload.goal,
              summary: goalEvent.progress.summary,
              status,
              updatedAt: Date.now(),
            })
          } else if (goalEvent.type === 'error') {
            await getAgentOsScheduler().transitionTask(payload.conversationId, 'goal', 'failed', goalEvent.error)
          } else if (planner?.paused) {
            await getAgentOsScheduler().transitionTask(payload.conversationId, 'goal', 'paused', 'Goal task paused.')
          }
          send(goalEvent)
        }
      } catch (err: any) {
        const error = err?.message ?? String(err)
        if (persistedProgress) {
          persistedProgress = markGoalProgressFailed(persistedProgress, error)
        }
        await getStorage().taskRuns.save({
          conversationId: payload.conversationId,
          kind: 'goal',
          status: 'failed',
          progress: persistedProgress || undefined,
          error,
          checkpoints,
        })
        await syncActivePlan(payload.conversationId)
        await getAgentOsScheduler().transitionTask(payload.conversationId, 'goal', 'failed', error)
        await getStorage().runtimeMemory.recordTaskOutcome({
          conversationId: payload.conversationId,
          kind: 'goal',
          goal: payload.goal,
          summary: error,
          status: 'failed',
          updatedAt: Date.now(),
        })
        void recordActivity({ category: 'agent', action: 'goal.failed', status: 'error', summary: 'Goal-driven task failed.', conversationId: payload.conversationId }, win)
        send({ type: 'error', error })
          } finally {
            if (planner && activeGoalPlanners.get(payload.conversationId) === planner) {
              activeGoalPlanners.delete(payload.conversationId)
            }
          }
          const snapshot = await getStorage().taskRuns.get(payload.conversationId)
          const nonRetryableFailure = /no available model connection|task services not initialized|agent .+ not found/i.test(snapshot?.error || '')
          return {
            status: snapshot?.status === 'cancelled' ? 'cancelled' as const : snapshot?.status === 'failed' ? 'failed' as const : 'completed' as const,
            error: snapshot?.error,
            retryable: snapshot?.status === 'failed' ? !nonRetryableFailure : undefined,
          }
        }
      })
  }
  ipcMain.on(IPC.TASK_GOAL_START, (event, payload: GoalTaskStartInput) => {
    void startGoalTaskRun(event, payload)
  })

  // Goal mode - abort
  ipcMain.on(IPC.TASK_GOAL_ABORT, (event, conversationId: string) => {
    void cancelTaskRun(conversationId, 'goal').then(() => notifyConversationChanged(event, conversationId))
  })

  // Goal mode - pause
  ipcMain.handle(IPC.TASK_GOAL_PAUSE, async (event, conversationId: string): Promise<void> => {
    const background = await controlBackgroundGoal(conversationId, 'pause')
    if (background.handled) {
      notifyConversationChanged(event, conversationId)
      return
    }
    const planner = activeGoalPlanners.get(conversationId)
    if (!planner) throw new Error('This Goal is no longer running.')
    planner.pause()
    const snapshot = await getStorage().taskRuns.get(conversationId)
    if (!snapshot) throw new Error('This Goal has no persisted task record.')
    await getStorage().taskRuns.save({ ...snapshot, status: 'paused' })
    await getStorage().conversations.updateConversation(conversationId, { executionStatus: 'paused', executionUpdatedAt: Date.now() })
    await getAgentOsScheduler().transitionTask(conversationId, 'goal', 'paused', 'Paused by the user.')
    notifyConversationChanged(event, conversationId)
  })

  // Goal mode - resume
  ipcMain.handle(IPC.TASK_GOAL_RESUME, async (event, conversationId: string): Promise<void> => {
    const background = await controlBackgroundGoal(conversationId, 'resume')
    if (background.handled) {
      notifyConversationChanged(event, conversationId)
      return
    }
    const planner = activeGoalPlanners.get(conversationId)
    if (!planner) throw new Error('This Goal is not available for in-process resume.')
    planner.resume()
    const snapshot = await getStorage().taskRuns.get(conversationId)
    if (!snapshot) throw new Error('This Goal has no persisted task record.')
    await getStorage().taskRuns.save({ ...snapshot, status: 'running' })
    await getStorage().conversations.updateConversation(conversationId, { executionStatus: 'running', executionUpdatedAt: Date.now() })
    await getAgentOsScheduler().transitionTask(conversationId, 'goal', 'running', 'Resumed by the user.')
    notifyConversationChanged(event, conversationId)
  })
}

/**
 * Requeues work that was waiting to start when Eva closed. Work that had
 * already started is marked interrupted at shutdown and deliberately waits for
 * an explicit Continue action in Task Center, so file-writing work never
 * resumes without the user seeing it.
 */
export async function recoverQueuedTasks(window: BrowserWindow): Promise<void> {
  const recoveredConversationIds = new Set(await getAgentOsScheduler().recoverQueued(window))
  const snapshots = await getStorage().taskRuns.list()
  for (const snapshot of snapshots) {
    if (snapshot.status !== 'queued') continue
    if (recoveredConversationIds.has(snapshot.conversationId)) continue

    const goal = snapshot.goal || snapshot.progress?.goal || snapshot.plan?.goal
    const conversation = await getStorage().conversations.getConversation(snapshot.conversationId)
    if (!goal || !conversation) {
      await getStorage().taskRuns.save({
        ...snapshot,
        status: 'failed',
        error: 'The queued task could not be restored because its conversation or original goal is unavailable.',
      })
      continue
    }

    const event = { sender: window.webContents } as IpcMainEvent
    const hasSavedProgress = Boolean(snapshot.progress?.steps.length || snapshot.plan?.subtasks.length)
    if (snapshot.kind === 'expert') {
      await startExpertTaskRun(event, { conversationId: snapshot.conversationId, goal, resume: hasSavedProgress, recoveryReason: 'app-restart' })
      continue
    }

    const agentId = snapshot.agentId || conversation.agentId
    if (!agentId) {
      await getStorage().taskRuns.save({
        ...snapshot,
        status: 'failed',
        error: 'The queued Goal task could not be restored because its agent is unavailable.',
      })
      continue
    }
    await startGoalTaskRun(event, { goal, conversationId: snapshot.conversationId, agentId, resume: hasSavedProgress, recoveryReason: 'app-restart' })
  }
}
