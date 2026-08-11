import type { AgentConfig } from '../../shared/types/agent'
import type { ChatMessage, Conversation } from '../../shared/types/conversation'
import type { CostUsageRecord, CostUsageReport, ModelRateCard } from '../../shared/types/cost'
import type { ProviderConfigEntry } from '../../shared/types/provider'
import { getStorage } from '../storage'

function matchingRateCard(rateCards: ModelRateCard[], providerId: string, model: string): ModelRateCard | undefined {
  return rateCards.find((rate) => rate.providerId === providerId && rate.model === model)
    || rateCards.find((rate) => rate.providerId === providerId && rate.model === '*')
}

function estimatedCost(usage: NonNullable<ChatMessage['usage']>, rateCard?: ModelRateCard): number | undefined {
  if (!rateCard) return usage.estimatedCostCny
  const cached = Math.min(usage.promptTokens, Math.max(0, usage.cachedTokens || 0))
  const uncached = Math.max(0, usage.promptTokens - cached)
  return (
    (uncached * rateCard.inputCnyPerMillion)
    + (cached * (rateCard.cachedInputCnyPerMillion ?? rateCard.inputCnyPerMillion))
    + (usage.completionTokens * rateCard.outputCnyPerMillion)
  ) / 1_000_000
}

function usageRecord(
  message: ChatMessage,
  conversation: Conversation,
  agents: AgentConfig[],
  providers: ProviderConfigEntry[],
  rateCards: ModelRateCard[],
): CostUsageRecord | null {
  if (message.role !== 'assistant' || !message.usage) return null
  const agent = agents.find((candidate) => candidate.id === message.agentId || candidate.id === conversation.agentId)
  const providerId = message.providerId || agent?.providerId || 'unknown'
  const provider = providers.find((candidate) => candidate.id === providerId)
  const model = message.model || agent?.model || 'unknown'
  const rateCard = matchingRateCard(rateCards, providerId, model)
  const usage = message.usage
  return {
    id: message.id,
    timestamp: message.timestamp,
    conversationId: conversation.id,
    providerId,
    providerName: message.providerName || provider?.name || agent?.name || providerId,
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens || 0,
    cacheMissTokens: usage.cacheMissTokens ?? Math.max(0, usage.promptTokens - (usage.cachedTokens || 0)),
    modelCalls: usage.modelCalls || 1,
    estimatedCostCny: estimatedCost(usage, rateCard),
    rateCardId: rateCard?.id,
  }
}

export async function getCostUsageReport(): Promise<CostUsageReport> {
  const storage = getStorage()
  const [conversations, agents, providers] = await Promise.all([
    storage.conversations.listConversations(),
    storage.agents.listAgents(),
    storage.config.getProviders(),
  ])
  const rateCards = storage.config.get('costRateCards')
  const records: CostUsageRecord[] = []
  for (const conversation of conversations) {
    const messages = await storage.conversations.getMessages(conversation.id)
    for (const message of messages) {
      const record = usageRecord(message, conversation, agents, providers, rateCards)
      if (record) records.push(record)
    }
  }
  return { generatedAt: Date.now(), records: records.sort((left, right) => right.timestamp - left.timestamp), rateCards }
}
