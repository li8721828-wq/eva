import fs from 'fs'
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
import { getStorage } from '../storage'
import { v4 as uuidv4 } from 'uuid'
import { recordActivity } from '../services/activity-log'
import { sanitizeToolHistory } from '../agent-engine/tool-history'
import { SpecService } from '../services/spec-service'
import type { AutomationConfig } from '../../shared/types/automation'
import { DEFAULT_AUTOMATION_CONFIG } from '../../shared/types/automation'
import type { ChatMessageInput } from '../../shared/types/provider'

export interface ChatServices {
  toolRegistry: ToolRegistry
  providerRegistry: ProviderRegistry
  fileService: FileService
  terminalService: TerminalService
}

// Each conversation owns its runner. A model connection may be shared, but the
// prompt history, cancellation handle, and lifecycle must stay conversation-scoped.
const activeRunners = new Map<string, AgentRunner>()
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
      data: { title?: string; agentId?: string; mode?: 'normal' | 'expert' | 'goal'; workspaceId?: string; workspacePath?: string; accessScope?: Conversation['accessScope']; permissionLevel?: Conversation['permissionLevel']; fileAccessGrants?: Conversation['fileAccessGrants'] }
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
      data: Partial<Pick<Conversation, 'title' | 'agentId' | 'archived' | 'permissionLevel' | 'fileAccessGrants'>>
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
              const worker = new AgentRunner({
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
              for await (const event of worker.run({ messages: [], newMessage: taskMessage })) {
                if (event.type === 'text' && event.content) output += event.content
                if (event.type === 'tool_result' && event.toolResult) output += `\n[${event.toolResult.name}] ${event.toolResult.result}`
                if (event.type === 'error') throw new Error(event.error)
              }
              return output.trim() || 'Task execution completed.'
            }
          : undefined
        const runGoal = automation.goal.enabled && automation.goal.autoInvoke
          ? async (goal: string): Promise<string> => {
              const planner = new GoalPlanner({
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
                timeout: automation.goal.timeoutMinutes * 60 * 1000,
              })
              let summary = ''
              for await (const event of planner.run({ goal, maxSteps: automation.goal.maxSteps, timeout: automation.goal.timeoutMinutes * 60 * 1000, autoAdjust: true })) {
                if (!win.isDestroyed()) {
                  win.webContents.send(IPC.TASK_GOAL_STREAM, { ...event, conversationId })
                }
                if (event.type === 'summary') summary = event.content
                if (event.type === 'error') throw new Error(event.error)
              }
              return summary || 'Goal execution completed.'
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
          createExecutionPlan,
          applySpecTemplate,
        })
        // A second send in the same chat replaces the prior run; other chats
        // retain their own runners and continue independently.
        activeRunners.get(conversationId)?.abort()
        activeRunners.set(conversationId, runner)

        // 6. Execute the ReAct loop and stream events
        const allToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
        const allToolResults: Array<{ toolCallId: string; name: string; result: string; isError: boolean }> = []
        let assistantContent = ''
        let runError: string | null = null

        for await (const agentEvent of runner.run({ messages: historyMessages, newMessage: userChatMessage })) {
          // Accumulate content and tool info for persistence
          if (agentEvent.type === 'text' && agentEvent.content) {
            // 'text' events carry full reasoning content (emitted before tool calls)
            // text_delta events carry incremental chunks
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
                  result: result?.result,
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
            content: tr.result,
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
    }
  })
}
