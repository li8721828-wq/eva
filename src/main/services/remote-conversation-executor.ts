import { v4 as uuidv4 } from 'uuid'
import type { ChatMessage, Conversation, ToolCall } from '../../shared/types/conversation'
import type { ChatServices } from '../ipc/conversation'
import { AgentRunner } from '../agent-engine/agent-runner'
import { ContextManager } from '../agent-engine/context'
import { getStorage } from '../storage'
import { recordActivity } from './activity-log'
import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { createRemoteToolApproval } from './remote-tool-policy'
import { sanitizeToolHistory } from '../agent-engine/tool-history'

function notifyConversationChanged(conversationId: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.CONVERSATION_CHANGED, conversationId)
  }
}

function getConversationAccess(conversation: Conversation): { fileAccessGrants: import('../../shared/types/file-access').FileAccessGrant[]; fullFilesystemAccess: boolean } {
  if (conversation.permissionLevel === 'full-access') return { fileAccessGrants: [], fullFilesystemAccess: true }
  if (conversation.permissionLevel === 'granted-folders') return { fileAccessGrants: conversation.fileAccessGrants || [], fullFilesystemAccess: false }
  return { fileAccessGrants: [], fullFilesystemAccess: false }
}

/** Runs an existing Eva conversation without a renderer IPC sender. */
export async function executeRemoteConversationMessage(
  services: ChatServices,
  conversationId: string,
  message: string
): Promise<string> {
  const storage = getStorage()
  const conversation = await storage.conversations.getConversation(conversationId)
  if (!conversation) throw new Error(`Conversation ${conversationId} not found`)

  let agentConfig = conversation.agentId ? await storage.agents.getAgent(conversation.agentId) : null
  if (!agentConfig) {
    const agents = await storage.agents.listAgents()
    agentConfig = agents[0] || null
  }
  if (!agentConfig) throw new Error('No agent is configured.')

  const effectiveAgent = agentConfig.isBuiltIn
    ? { ...agentConfig, providerId: storage.config.get('activeProviderId'), model: storage.config.getActiveModel() }
    : agentConfig
  const provider = services.providerRegistry.get(effectiveAgent.providerId)
  if (!provider) throw new Error(`Provider ${effectiveAgent.providerId} is not available.`)

  const history = sanitizeToolHistory(await storage.conversations.getMessages(conversationId))
  const userMessage: ChatMessage = {
    id: uuidv4(),
    conversationId,
    role: 'user',
    content: message,
    timestamp: Date.now(),
  }
  await storage.conversations.addMessage(conversationId, userMessage)
  notifyConversationChanged(conversationId)

  const access = getConversationAccess(conversation)
  const runner = new AgentRunner({
    agentConfig: effectiveAgent,
    provider,
    toolRegistry: services.toolRegistry,
    contextManager: new ContextManager(),
    workspacePath: conversation.workspacePath,
    fileAccessGrants: access.fileAccessGrants,
    fullFilesystemAccess: access.fullFilesystemAccess,
    fileService: services.fileService,
    terminalService: services.terminalService,
    requestToolApproval: createRemoteToolApproval({
      conversationId,
      workspaceId: conversation.workspaceId,
    }),
  })

  void recordActivity({
    category: 'agent',
    action: 'qq.agent_started',
    status: 'info',
    summary: `${effectiveAgent.name} started a QQ remote response.`,
    conversationId,
    workspaceId: conversation.workspaceId,
  })

  const toolCalls: ToolCall[] = []
  let assistantContent = ''
  try {
    for await (const event of runner.run({ messages: history, newMessage: userMessage })) {
      if (event.type === 'text' && event.content) assistantContent += event.content
      if (event.type === 'done' && event.content) assistantContent = event.content
      if (event.type === 'tool_call' && event.toolCall) {
        toolCalls.push({ ...event.toolCall })
        void recordActivity({
          category: 'tool', action: 'qq.tool_started', status: 'info',
          summary: `${effectiveAgent.name} started ${event.toolCall.name} from QQ.`,
          conversationId, workspaceId: conversation.workspaceId,
        })
      }
      if (event.type === 'tool_result' && event.toolResult) {
        const toolCall = toolCalls.find((item) => item.id === event.toolResult?.toolCallId)
        if (toolCall) {
          toolCall.result = event.toolResult.result
          toolCall.isError = event.toolResult.isError
        }
        void recordActivity({
          category: 'tool', action: 'qq.tool_completed', status: event.toolResult.isError ? 'error' : 'success',
          summary: `${event.toolResult.name} ${event.toolResult.isError ? 'failed' : 'completed'} from QQ.`,
          conversationId, workspaceId: conversation.workspaceId,
        })
      }
      if (event.type === 'error') throw new Error(event.error || 'The agent failed to respond.')
    }

    await storage.conversations.addMessage(conversationId, {
      id: uuidv4(),
      conversationId,
      role: 'assistant',
      content: assistantContent,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      agentId: agentConfig.id,
      agentName: agentConfig.name,
      timestamp: Date.now(),
    })
    for (const toolCall of toolCalls) {
      if (toolCall.result === undefined) continue
      await storage.conversations.addMessage(conversationId, {
        id: uuidv4(),
        conversationId,
        role: 'tool',
        content: toolCall.result,
        toolCallId: toolCall.id,
        agentId: agentConfig.id,
        agentName: agentConfig.name,
        timestamp: Date.now(),
      })
    }
    notifyConversationChanged(conversationId)
    void recordActivity({
      category: 'agent', action: 'qq.agent_completed', status: 'success',
      summary: `${effectiveAgent.name} completed a QQ remote response.`,
      conversationId, workspaceId: conversation.workspaceId,
    })
    return assistantContent || 'The agent completed without a text response.'
  } catch (error) {
    void recordActivity({
      category: 'agent', action: 'qq.agent_failed', status: 'error',
      summary: 'QQ remote agent response failed.', conversationId, workspaceId: conversation.workspaceId,
    })
    throw error
  }
}
