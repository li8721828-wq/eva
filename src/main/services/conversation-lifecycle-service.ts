import type { ChatMessage, Conversation } from '../../shared/types/conversation'
import type { StorageManager } from '../storage'
import { ensureProviderPricing } from './supplier-pricing-service'
import { hydrateUsagePricing } from './usage-pricing-service'

export type CreateConversationInput = {
  title?: string
  agentId?: string
  mode?: 'normal' | 'expert' | 'goal'
  workspaceId?: string
  workspacePath?: string
  accessScope?: Conversation['accessScope']
  permissionLevel?: Conversation['permissionLevel']
  fileAccessGrants?: Conversation['fileAccessGrants']
  symposium?: Conversation['symposium']
}

export type UpdateConversationInput = Partial<Pick<Conversation,
  'title' | 'titleSource' | 'agentId' | 'archived' | 'permissionLevel' | 'fileAccessGrants' | 'multiDimensionalIndexEnabled' | 'symposium' | 'executionStatusAcknowledgedAt'
>>

/** Storage-backed conversation operations that have no renderer or Agent-runner dependency. */
export class ConversationLifecycleService {
  constructor(private readonly storage: StorageManager) {}

  list(): Promise<Conversation[]> {
    return this.storage.conversations.listConversations()
  }

  async create(data: CreateConversationInput): Promise<Conversation> {
    const workspace = data.workspaceId ? await this.storage.workspaces.get(data.workspaceId) : null
    const agents = data.agentId ? [] : await this.storage.agents.listAgents()
    const primaryAgentId = this.storage.config.get('primaryChatAgentId')
    const defaultAgent = data.agentId ? null : agents.find((agent) => agent.id === primaryAgentId) || agents[0]
    return this.storage.conversations.createConversation({
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
  }

  async delete(id: string): Promise<Conversation | null> {
    const conversation = await this.storage.conversations.getConversation(id)
    await this.storage.conversations.deleteConversation(id)
    return conversation
  }

  async load(id: string): Promise<{ conversation: Conversation; messages: ChatMessage[] }> {
    const conversation = await this.storage.conversations.getConversation(id)
    if (!conversation) throw new Error(`Conversation ${id} not found`)
    const storedMessages = await this.storage.conversations.getMessages(id)
    const providerIds = Array.from(new Set(storedMessages
      .filter((message) => message.usage && message.providerId)
      .map((message) => message.providerId)
      .filter((providerId): providerId is string => Boolean(providerId))))
    await Promise.all(providerIds.map((providerId) => ensureProviderPricing(providerId).catch(() => undefined)))
    const messages = storedMessages.map((message) => message.usage
      ? { ...message, usage: hydrateUsagePricing(message.providerId, message.model, message.usage) }
      : message)
    return { conversation, messages }
  }

  async update(id: string, data: UpdateConversationInput): Promise<Conversation | null> {
    const conversation = await this.storage.conversations.getConversation(id)
    await this.storage.conversations.updateConversation(id, {
      ...data,
      ...(data.title && !data.titleSource ? { titleSource: 'manual' } : {}),
    })
    return conversation
  }

  updateMessage(conversationId: string, messageId: string, data: Partial<Pick<ChatMessage, 'favorited'>>): Promise<void> {
    return this.storage.conversations.updateMessage(conversationId, messageId, data)
  }

  deleteMessages(conversationId: string, messageId: string): Promise<void> {
    return this.storage.conversations.deleteMessages(conversationId, messageId)
  }
}
