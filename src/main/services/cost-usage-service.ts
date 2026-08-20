import type { AgentConfig } from '../../shared/types/agent'
import type { ChatMessage, Conversation } from '../../shared/types/conversation'
import type { CostUsageRecord, CostUsageReport, ModelRateCard } from '../../shared/types/cost'
import type { ProviderConfigEntry } from '../../shared/types/provider'
import { getStorage } from '../storage'
import { calculateRateCardCost, findMatchingRateCard } from './usage-pricing-service'

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
  const rateCard = findMatchingRateCard(rateCards, providerId, model)
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
    // A message keeps its original price snapshot. Legacy messages without one
    // are calculated from the currently saved rate card.
    estimatedCostCny: usage.providerReportedCurrency?.toUpperCase() === 'CNY'
      ? usage.providerReportedCost
      : usage.estimatedCostCny ?? ((rateCard?.currency || 'CNY').toUpperCase() === 'CNY' && rateCard ? calculateRateCardCost(usage, rateCard) : undefined),
    estimatedCost: usage.estimatedCost,
    estimatedCostCurrency: usage.estimatedCostCurrency,
    providerReportedCost: usage.providerReportedCost,
    providerReportedCurrency: usage.providerReportedCurrency,
    costSource: usage.costSource || (rateCard ? 'rate-card' : undefined),
    rateCardId: usage.rateCardId || rateCard?.id,
    pricingMode: usage.pricingMode,
    pricingSourceUrl: usage.pricingSourceUrl || rateCard?.sourceUrl,
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
