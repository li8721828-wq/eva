import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { Conversation, ChatMessage, ToolCall } from '../../shared/types/conversation'
import type { AgentEvent } from '../../shared/types/agent'
import type { ToolRegistry, FileService, TerminalService } from '../tools'
import type { ProviderRegistry } from '../providers'
import { AgentRunner } from '../agent-engine/agent-runner'
import { ContextManager } from '../agent-engine/context'
import { getStorage } from '../storage'
import { v4 as uuidv4 } from 'uuid'

export interface ChatServices {
  toolRegistry: ToolRegistry
  providerRegistry: ProviderRegistry
  fileService: FileService
  terminalService: TerminalService
}

// Module-level reference to the currently running AgentRunner (for abort)
let currentRunner: AgentRunner | null = null

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
      return getStorage().conversations.createConversation({
        title: data.title || 'New Conversation',
        agentId: data.agentId || '',
        mode: data.mode || 'normal',
        workspaceId: workspace?.id,
        accessScope: workspace ? 'workspace' : data.accessScope,
        permissionLevel: data.permissionLevel || (workspace ? 'workspace' : 'full-access'),
        fileAccessGrants: data.fileAccessGrants || [],
        workspacePath: data.workspacePath ?? workspace?.path ?? getStorage().config.get('workspacePath'),
      })
    }
  )

  ipcMain.handle(IPC.CONVERSATION_DELETE, async (_event, id: string): Promise<void> => {
    await getStorage().conversations.deleteConversation(id)
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
      _event,
      id: string,
      data: Partial<Pick<Conversation, 'title' | 'archived' | 'permissionLevel' | 'fileAccessGrants'>>
    ): Promise<void> => {
      await getStorage().conversations.updateConversation(id, data)
    }
  )

  // ─── Chat: send (fire-and-forget; events streamed via CHAT_STREAM) ──────────

  ipcMain.on(
    IPC.CHAT_SEND,
    async (event, payload: { conversationId: string; message: string; agentId?: string }) => {
      const { conversationId, message } = payload
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return

      const send = (streamEvent: AgentEvent & { conversationId?: string }): void => {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.CHAT_STREAM, { ...streamEvent, conversationId })
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
        const historyMessages = await convStore.getMessages(conversationId)

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

        const provider = services.providerRegistry.get(effectiveAgentConfig.providerId)
        if (!provider) {
          send({ type: 'error', error: `Provider ${effectiveAgentConfig.providerId} not available` })
          send({ type: 'done', content: '' })
          return
        }

        // 4. Save user message to storage immediately
        const userMessageId = uuidv4()
        const userChatMessage: ChatMessage = {
          id: userMessageId,
          conversationId,
          role: 'user',
          content: message,
          timestamp: Date.now(),
        }
        await convStore.addMessage(conversationId, userChatMessage)

        // 5. Create AgentRunner
        const workspaceAccess = await getConversationAccess(conversation)
        const runner = new AgentRunner({
          agentConfig: effectiveAgentConfig,
          provider,
          toolRegistry: services.toolRegistry,
          contextManager: new ContextManager(),
          workspacePath: conversation.workspacePath || (workspaceAccess.fullFilesystemAccess ? '' : getStorage().config.get('workspacePath')),
          fileAccessGrants: workspaceAccess.fileAccessGrants,
          fullFilesystemAccess: workspaceAccess.fullFilesystemAccess,
          fileService: services.fileService,
          terminalService: services.terminalService,
        })
        currentRunner = runner

        // 6. Execute the ReAct loop and stream events
        const allToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
        const allToolResults: Array<{ toolCallId: string; name: string; result: string; isError: boolean }> = []
        let assistantContent = ''

        for await (const agentEvent of runner.run({ messages: historyMessages, newMessage: message })) {
          // Accumulate content and tool info for persistence
          if (agentEvent.type === 'text' && agentEvent.content) {
            // 'text' events carry full reasoning content (emitted before tool calls)
            // text_delta events carry incremental chunks
            assistantContent += agentEvent.content
          }
          if (agentEvent.type === 'tool_call' && agentEvent.toolCall) {
            allToolCalls.push(agentEvent.toolCall)
          }
          if (agentEvent.type === 'tool_result' && agentEvent.toolResult) {
            allToolResults.push(agentEvent.toolResult)
          }
          if (agentEvent.type === 'done' && agentEvent.content) {
            assistantContent = agentEvent.content
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
          content: assistantContent,
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
      } catch (err: any) {
        send({ type: 'error', error: err?.message ?? String(err) })
        send({ type: 'done', content: '' })
      } finally {
        currentRunner = null
      }
    }
  )

  // ─── Chat: abort ────────────────────────────────────────────────────────────

  ipcMain.on(IPC.CHAT_ABORT, (_event, conversationId?: string) => {
    if (currentRunner) {
      currentRunner.abort()
    }
  })
}
