import { describe, expect, it } from 'vitest'
import type { ModelRateCard } from '../../src/shared/types/cost'
import { calculateRateCardCost, calculateRateCardCostCny, findMatchingRateCard } from '../../src/main/services/usage-pricing-service'

const exactRate: ModelRateCard = {
  id: 'qwen-exact',
  providerId: 'dashscope',
  model: 'qwen-plus',
  inputCnyPerMillion: 2,
  cachedInputCnyPerMillion: 0.2,
  outputCnyPerMillion: 6,
  updatedAt: 1,
}

describe('usage pricing service', () => {
  it('prefers the model-specific rate card over the supplier wildcard', () => {
    const wildcard: ModelRateCard = { ...exactRate, id: 'dashscope-default', model: '*' }
    expect(findMatchingRateCard([wildcard, exactRate], 'dashscope', 'qwen-plus')).toBe(exactRate)
  })

  it('prefers a supplier-synchronized card over a manual card for the same connection and model', () => {
    const manual: ModelRateCard = { ...exactRate, id: 'manual-card' }
    const supplier: ModelRateCard = { ...exactRate, id: 'supplier-card', source: 'supplier-site', sourceUrl: 'https://supplier.example/pricing' }
    expect(findMatchingRateCard([manual, supplier], 'dashscope', 'qwen-plus')).toBe(supplier)
  })

  it('uses the cached input rate only for reported cached tokens', () => {
    const cost = calculateRateCardCostCny({ promptTokens: 1_000_000, completionTokens: 500_000, cachedTokens: 250_000 }, exactRate)
    expect(cost).toBeCloseTo(4.55, 8)
  })

  it('uses the supplier-native rate fields when a synchronized card provides them', () => {
    const usdCard: ModelRateCard = {
      ...exactRate,
      inputPerMillion: 0.4,
      cachedInputPerMillion: 0.04,
      outputPerMillion: 2,
      currency: 'USD',
      source: 'supplier-site',
    }
    expect(calculateRateCardCost({ promptTokens: 1_000_000, completionTokens: 500_000, cachedTokens: 250_000 }, usdCard)).toBeCloseTo(1.31, 8)
  })
})
