import { describe, expect, it } from 'vitest'
import type { ProviderConfigEntry } from '../../src/shared/types/provider'
import { parseApilioRateCards } from '../../src/main/services/supplier-pricing-service'

const provider: ProviderConfigEntry = {
  id: 'apilio-connection',
  name: 'Apilio route A',
  type: 'custom',
  apiKey: '',
  baseUrl: 'https://api.apilio.ai/v1',
  isEnabled: true,
  defaultModel: 'model-a',
  models: [{ id: 'model-a', name: 'model-a' }],
}

describe('supplier pricing service', () => {
  it('uses a supplier price group for the specific connection and never emits unrelated models', () => {
    const cards = parseApilioRateCards(provider, {
      data: {
        models: [{
          key: 'model-a',
          completion_ratio: 5,
          group_price: {
            default: { price: 0.4, cache_hits_ratio: 0.1, currency: 'USD' },
            premium: { price: 0.8, cache_hits_ratio: 0.1, currency: 'USD' },
          },
        }, {
          id: 'same-model-on-another-route',
          completion_ratio: 5,
          group_price: { default: { price: 10 } },
        }],
      },
    })

    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ providerId: 'apilio-connection', model: 'model-a', inputPerMillion: 0.4, outputPerMillion: 2, currency: 'USD', sourceGroup: 'default' })
    expect(cards[0].cachedInputPerMillion).toBeCloseTo(0.04, 8)
  })

  it('uses the explicitly configured supplier price group instead of the default group', () => {
    const cards = parseApilioRateCards({ ...provider, pricingGroup: 'premium' }, {
      data: { models: [{ id: 'model-a', completion_ratio: 2, group_price: { default: { price: 0.4 }, premium: { price: 0.8 } } }] },
    })
    expect(cards[0]).toMatchObject({ inputPerMillion: 0.8, outputPerMillion: 1.6, sourceGroup: 'premium' })
  })
})
