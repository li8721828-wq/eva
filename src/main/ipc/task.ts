import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { GoalConfig, TeamEvent } from '../../shared/types/task'
import type { AgentConfig } from '../../shared/types/agent'
import type { Conversation } from '../../shared/types/conversation'
import type { ToolRegistry, FileService, TerminalService } from '../tools'
import type { ProviderRegistry } from '../providers'
import { ContextManager } from '../agent-engine/context'
import { TeamOrchestrator } from '../agent-engine/team-orchestrator'
import { GoalPlanner } from '../agent-engine/goal-planner'
import type { GoalEvent } from '../agent-engine/goal-planner'
import { getStorage } from '../storage'

export interface TaskServices {
  toolRegistry: ToolRegistry
  providerRegistry: ProviderRegistry
  fileService: FileService
  terminalService: TerminalService
}

// Module-level references for abort
let currentOrchestrator: TeamOrchestrator | null = null
let currentGoalPlanner: GoalPlanner | null = null
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

        // 2. Get provider
        const provider = taskServices.providerRegistry.get(leader.providerId)
        if (!provider) {
          send({
            type: 'error',
            error: `Provider '${leader.providerId}' not available. Please configure a provider.`,
          })
          send({ type: 'done' })
          return
        }

        // 3. Load conversation for workspace path
        const conversation = await getStorage().conversations.getConversation(conversationId)
        const workspaceAccess = await getConversationAccess(conversation)
        const workspacePath = conversation?.workspacePath || (workspaceAccess.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath'))

        // 4. Create TeamOrchestrator
        const orchestrator = new TeamOrchestrator({
          leader,
          workers,
          provider,
          toolRegistry: taskServices.toolRegistry,
          contextManager: new ContextManager(),
          workspacePath,
          fileAccessGrants: workspaceAccess.grants,
          fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
          fileService: taskServices.fileService,
          terminalService: taskServices.terminalService,
        })
        currentOrchestrator = orchestrator

        // 5. Execute and stream events
        for await (const teamEvent of orchestrator.run({ goal })) {
          send(teamEvent)
        }
      } catch (err: any) {
        send({ type: 'error', error: err?.message ?? String(err) })
        send({ type: 'done' })
      } finally {
        currentOrchestrator = null
      }
    }
  )

  // Expert mode - abort
  ipcMain.on(IPC.TASK_ABORT, (_event, _conversationId: string) => {
    if (currentOrchestrator) {
      currentOrchestrator.abort()
    }
  })

  // Expert mode - status
  ipcMain.handle(IPC.TASK_STATUS, async (_event, _conversationId: string): Promise<string> => {
    return currentOrchestrator ? 'running' : 'idle'
  })

  // ─── Goal Mode ──────────────────────────────────────────────────────────────

  // Goal mode - start (fire-and-forget; events streamed via TASK_GOAL_STREAM)
  ipcMain.on(
    IPC.TASK_GOAL_START,
    async (event, payload: { goal: string; config?: Partial<GoalConfig>; conversationId: string; agentId: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return

      const send = (goalEvent: GoalEvent): void => {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.TASK_GOAL_STREAM, goalEvent)
        }
      }

      try {
        if (!taskServices) {
          send({ type: 'error', error: 'Task services not initialized' })
          return
        }

        // 1. Load agent config
        const agentConfig = await getStorage().agents.getAgent(payload.agentId)
        if (!agentConfig) {
          send({ type: 'error', error: `Agent ${payload.agentId} not found` })
          return
        }

        // 2. Get LLM provider
        const provider = taskServices.providerRegistry.get(agentConfig.providerId)
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

        const planner = new GoalPlanner({
          agentConfig,
          provider,
          toolRegistry: taskServices.toolRegistry,
          contextManager: new ContextManager(),
          workspacePath,
          fileAccessGrants: workspaceAccess.grants,
          fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
          fileService: taskServices.fileService,
          terminalService: taskServices.terminalService,
          maxSteps: goalConfig.maxSteps,
          timeout: goalConfig.timeout,
        })
        currentGoalPlanner = planner

        // 5. Execute and stream events
        for await (const goalEvent of planner.run(goalConfig)) {
          send(goalEvent)
        }
      } catch (err: any) {
        send({ type: 'error', error: err?.message ?? String(err) })
      } finally {
        currentGoalPlanner = null
      }
    }
  )

  // Goal mode - abort
  ipcMain.on(IPC.TASK_GOAL_ABORT, () => {
    if (currentGoalPlanner) {
      currentGoalPlanner.abort()
    }
  })

  // Goal mode - pause
  ipcMain.on(IPC.TASK_GOAL_PAUSE, () => {
    if (currentGoalPlanner) {
      currentGoalPlanner.pause()
    }
  })

  // Goal mode - resume
  ipcMain.on(IPC.TASK_GOAL_RESUME, () => {
    if (currentGoalPlanner) {
      currentGoalPlanner.resume()
    }
  })
}
