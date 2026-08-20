import type { ChatUsage } from '../../shared/types/conversation'
import type { ModelRateCard } from '../../shared/types/cost'
import { getStorage } from '../storage'

const VOLCENGINE_CODING_PLAN_URL = 'https://developer.volcengine.com/articles/7616633140483719219'

export function findMatchingRateCard(rateCards: ModelRateCard[], providerId: string, model: string): ModelRateCard | undefined {
  const exact = rateCards.filter((rate) => rate.providerId === providerId && rate.model === model)
  const wildcard = rateCards.filter((rate) => rate.providerId === providerId && rate.model === '*')
  return exact.find((rate) => rate.source === 'supplier-site')
    || exact[0]
    || wildcard.find((rate) => rate.source === 'supplier-site')
    || wildcard[0]
}

export function calculateRateCardCostCny(
  usage: Pick<ChatUsage, 'promptTokens' | 'completionTokens' | 'cachedTokens'>,
  rateCard: ModelRateCard,
): number {
  const cached = Math.min(usage.promptTokens, Math.max(0, usage.cachedTokens || 0))
  const uncached = Math.max(0, usage.promptTokens - cached)
  return (
    (uncached * rateCard.inputCnyPerMillion)
    + (cached * (rateCard.cachedInputCnyPerMillion ?? rateCard.inputCnyPerMillion))
    + (usage.completionTokens * rateCard.outputCnyPerMillion)
  ) / 1_000_000
}

export function calculateRateCardCost(
  usage: Pick<ChatUsage, 'promptTokens' | 'completionTokens' | 'cachedTokens'>,
  rateCard: ModelRateCard,
): number {
  const input = rateCard.inputPerMillion ?? rateCard.inputCnyPerMillion
  const cachedInput = rateCard.cachedInputPerMillion ?? rateCard.cachedInputCnyPerMillion ?? input
  const output = rateCard.outputPerMillion ?? rateCard.outputCnyPerMillion
  const cached = Math.min(usage.promptTokens, Math.max(0, usage.cachedTokens || 0))
  const uncached = Math.max(0, usage.promptTokens - cached)
  return ((uncached * input) + (cached * cachedInput) + (usage.completionTokens * output)) / 1_000_000
}

export function resolveRateCardUsageCost(
  providerId: string,
  model: string,
  usage: Pick<ChatUsage, 'promptTokens' | 'completionTokens' | 'cachedTokens'>,
): Pick<ChatUsage, 'estimatedCostCny' | 'estimatedCost' | 'estimatedCostCurrency' | 'costSource' | 'rateCardId' | 'rateCardUpdatedAt' | 'pricingMode' | 'pricingSourceUrl'> {
  const rateCard = findMatchingRateCard(getStorage().config.get('costRateCards'), providerId, model)
  if (!rateCard) return {}
  const currency = (rateCard.currency || 'CNY').toUpperCase()
  const cost = calculateRateCardCost(usage, rateCard)

  return {
    ...(currency === 'CNY' ? { estimatedCostCny: cost } : { estimatedCost: cost, estimatedCostCurrency: currency }),
    costSource: 'rate-card',
    rateCardId: rateCard.id,
    rateCardUpdatedAt: rateCard.updatedAt,
    pricingMode: 'token',
    ...(rateCard.sourceUrl ? { pricingSourceUrl: rateCard.sourceUrl } : {}),
  }
}

/**
 * A Coding Plan is billed as a subscription/quota rather than as a direct price
 * for each response. Keeping this separate from rate cards prevents a zero-rate
 * card from looking like a real token estimate.
 */
export function resolveConnectionPricingMode(providerId: string): Pick<ChatUsage, 'pricingMode' | 'pricingSourceUrl'> {
  const provider = getStorage().config.getProvider(providerId)
  const endpoint = `${provider?.baseUrl || ''} ${provider?.name || ''}`.toLowerCase()
  const isCodingPlan = (endpoint.includes('ark.cn-') && endpoint.includes('/api/coding')) || endpoint.includes('coding plan')
  return isCodingPlan ? { pricingMode: 'subscription', pricingSourceUrl: VOLCENGINE_CODING_PLAN_URL } : {}
}

/** Apply the current connection's pricing metadata to a historical usage record.
 * Historical records retain actual supplier charges and prior estimates unchanged. */
export function hydrateUsagePricing(providerId: string | undefined, model: string | undefined, usage: ChatUsage): ChatUsage {
  if (!providerId || !model || usage.providerReportedCost !== undefined || usage.estimatedCostCny !== undefined || usage.estimatedCost !== undefined || usage.pricingMode) return usage
  const connectionPricing = resolveConnectionPricingMode(providerId)
  if (connectionPricing.pricingMode === 'subscription') return { ...usage, ...connectionPricing }
  return { ...usage, ...resolveRateCardUsageCost(providerId, model, usage) }
}
