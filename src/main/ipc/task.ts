import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { GoalConfig, TeamEvent } from '../../shared/types/task'
import type { AgentConfig } from '../../shared/types/agent'
import type { Conversation } from '../../shared/types/conversation'
import type { ChatMessage } from '../../shared/types/conversation'
import type { ToolRegistry, FileService, TerminalService } from '../tools'
import type { ProviderRegistry } from '../providers'
import { ContextManager } from '../agent-engine/context'
import { TeamOrchestrator } from '../agent-engine/team-orchestrator'
import { GoalPlanner } from '../agent-engine/goal-planner'
import type { GoalEvent } from '../agent-engine/goal-planner'
import { getStorage } from '../storage'
import { recordActivity } from '../services/activity-log'
import { v4 as uuidv4 } from 'uuid'

export interface TaskServices {
  toolRegistry: ToolRegistry
  providerRegistry: ProviderRegistry
  fileService: FileService
  terminalService: TerminalService
}

// Execution controls are keyed by conversation so separate chats can run in
// parallel without sharing a cancellation handle or status.
const activeOrchestrators = new Map<string, TeamOrchestrator>()
const activeGoalPlanners = new Map<string, GoalPlanner>()
let taskServices: TaskServices | null = null

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

export function registerTaskHandlers(services?: TaskServices): void {
  if (services) {
    taskServices = services
  }

  // ─── Expert Mode ────────────────────────────────────────────────────────────

  // Expert mode - start task (fire-and-forget; events streamed via TASK_STREAM)
  ipcMain.on(
    IPC.TASK_START,
    async (event, payload: { conversationId: string; goal: string }) => {
      const { conversationId, goal } = payload
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      let orchestrator: TeamOrchestrator | null = null

      const send = (teamEvent: TeamEvent): void => {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.TASK_STREAM, { ...teamEvent, conversationId })
        }
      }

      if (!taskServices) {
        send({ type: 'error', error: 'Task services not initialized' })
        send({ type: 'done' })
        return
      }
      const activeTaskServices = taskServices

      try {
        // 1. Load agents
        const agentStore = getStorage().agents
        const allAgents = await agentStore.listAgents()

        const leader = allAgents.find((a: AgentConfig) => a.role === 'leader')
        if (!leader) {
          send({ type: 'error', error: 'No leader agent found. Please create a leader agent first.' })
          send({ type: 'done' })
          return
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
          send({
            type: 'error',
            error: `No model connection for Team Leader is available. Configure its model access first.`,
          })
          send({ type: 'done' })
          return
        }

        // 3. Load conversation for workspace path
        const conversation = await getStorage().conversations.getConversation(conversationId)
        if (!conversation) {
          send({ type: 'error', error: 'Conversation not found.' })
          send({ type: 'done' })
          return
        }
        const workspaceAccess = await getConversationAccess(conversation)
        const workspacePath = conversation?.workspacePath || (workspaceAccess.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath'))
        const historyMessages = await getStorage().conversations.getMessages(conversationId, { limit: 12 })

        // Team work belongs to the same conversation as normal chat. Persist the
        // goal immediately so it remains available after switching modes or restart.
        const goalMessage: ChatMessage = {
          id: uuidv4(),
          conversationId,
          role: 'user',
          content: goal,
          timestamp: Date.now(),
        }
        await getStorage().conversations.addMessage(conversationId, goalMessage)
        win.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)

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
            id: uuidv4(),
            conversationId: childId,
            role,
            content,
            agentId: worker.id,
            agentName: worker.name,
            timestamp: Date.now(),
          })
          if (agentEvent.type === 'done' || agentEvent.type === 'error') {
            win.webContents.send(IPC.CONVERSATION_CHANGED, childId)
          }
        }

        // 4. Create TeamOrchestrator
        orchestrator = new TeamOrchestrator({
          leader,
          workers,
          providerForAgent: (agent) => taskServices?.providerRegistry.get(agent.providerId),
          fallbackModel: { providerId: getStorage().config.get('activeProviderId'), model: getStorage().config.getActiveModel() },
          toolRegistry: activeTaskServices.toolRegistry,
          contextManager: new ContextManager(),
          workspacePath,
          fileAccessGrants: workspaceAccess.grants,
          fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
          fileService: activeTaskServices.fileService,
          terminalService: activeTaskServices.terminalService,
          createWorkerConversation,
          onWorkerEvent: persistWorkerEvent,
        })
        activeOrchestrators.get(conversationId)?.abort()
        activeOrchestrators.set(conversationId, orchestrator)
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
        for await (const teamEvent of orchestrator.run({ goal, messages: historyMessages })) {
          if (teamEvent.type === 'summary') finalSummary = teamEvent.summary
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
          send(teamEvent)
        }

        if (finalSummary) {
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
      } catch (err: any) {
        void recordActivity({ category: 'agent', action: 'team.failed', status: 'error', summary: 'Expert Team task failed.', conversationId }, win)
        send({ type: 'error', error: err?.message ?? String(err) })
        send({ type: 'done' })
      } finally {
        if (orchestrator && activeOrchestrators.get(conversationId) === orchestrator) {
          activeOrchestrators.delete(conversationId)
        }
      }
    }
  )

  // Expert mode - abort
  ipcMain.on(IPC.TASK_ABORT, (_event, conversationId: string) => {
    activeOrchestrators.get(conversationId)?.abort()
  })

  // Expert mode - status
  ipcMain.handle(IPC.TASK_STATUS, async (_event, conversationId: string): Promise<string> => {
    return activeOrchestrators.has(conversationId) ? 'running' : 'idle'
  })

  // ─── Goal Mode ──────────────────────────────────────────────────────────────

  // Goal mode - start (fire-and-forget; events streamed via TASK_GOAL_STREAM)
  ipcMain.on(
    IPC.TASK_GOAL_START,
    async (event, payload: { goal: string; config?: Partial<GoalConfig>; conversationId: string; agentId: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      let planner: GoalPlanner | null = null

      const send = (goalEvent: GoalEvent): void => {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.TASK_GOAL_STREAM, { ...goalEvent, conversationId: payload.conversationId })
        }
      }

      try {
        if (!taskServices) {
          send({ type: 'error', error: 'Task services not initialized' })
          return
        }
        const activeTaskServices = taskServices

        // 1. Load agent config
        const agentConfig = await getStorage().agents.getAgent(payload.agentId)
        if (!agentConfig) {
          send({ type: 'error', error: `Agent ${payload.agentId} not found` })
          return
        }

        // 2. Get LLM provider
        const provider = activeTaskServices.providerRegistry.get(agentConfig.providerId)
        if (!provider) {
          send({ type: 'error', error: `Provider ${agentConfig.providerId} not available` })
          return
        }

        // 3. Get workspace path from conversation or config
        let conversation: Conversation | null = null
        if (payload.conversationId) {
          conversation = await getStorage().conversations.getConversation(payload.conversationId)
        }
        const workspaceAccess = await getConversationAccess(conversation)
        const workspacePath = conversation?.workspacePath || (workspaceAccess.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath') as string)

        // 4. Create GoalPlanner
        const goalConfig: GoalConfig = {
          goal: payload.goal,
          maxSteps: payload.config?.maxSteps ?? 15,
          timeout: payload.config?.timeout ?? 10 * 60 * 1000,
          autoAdjust: payload.config?.autoAdjust ?? true,
        }

        planner = new GoalPlanner({
          agentConfig,
          provider,
          toolRegistry: activeTaskServices.toolRegistry,
          contextManager: new ContextManager(),
          workspacePath,
          fileAccessGrants: workspaceAccess.grants,
          fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
          fileService: activeTaskServices.fileService,
          terminalService: activeTaskServices.terminalService,
          maxSteps: goalConfig.maxSteps,
          timeout: goalConfig.timeout,
        })
        activeGoalPlanners.get(payload.conversationId)?.abort()
        activeGoalPlanners.set(payload.conversationId, planner)
        void recordActivity({
          category: 'agent',
          action: 'goal.started',
          status: 'info',
          summary: `${agentConfig.name} started a goal-driven task.`,
          conversationId: payload.conversationId,
          workspaceId: conversation?.workspaceId,
        }, win)

        // 5. Execute and stream events
        for await (const goalEvent of planner.run(goalConfig)) {
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
          send(goalEvent)
        }
      } catch (err: any) {
        void recordActivity({ category: 'agent', action: 'goal.failed', status: 'error', summary: 'Goal-driven task failed.', conversationId: payload.conversationId }, win)
        send({ type: 'error', error: err?.message ?? String(err) })
      } finally {
        if (planner && activeGoalPlanners.get(payload.conversationId) === planner) {
          activeGoalPlanners.delete(payload.conversationId)
        }
      }
    }
  )

  // Goal mode - abort
  ipcMain.on(IPC.TASK_GOAL_ABORT, (_event, conversationId: string) => {
    activeGoalPlanners.get(conversationId)?.abort()
  })

  // Goal mode - pause
  ipcMain.on(IPC.TASK_GOAL_PAUSE, (_event, conversationId: string) => {
    activeGoalPlanners.get(conversationId)?.pause()
  })

  // Goal mode - resume
  ipcMain.on(IPC.TASK_GOAL_RESUME, (_event, conversationId: string) => {
    activeGoalPlanners.get(conversationId)?.resume()
  })
}
