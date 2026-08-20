export interface ModelRateCard {
  id: string
  providerId: string
  model: string
  /** Legacy CNY fields retained for existing user-entered rate cards. */
  inputCnyPerMillion: number
  cachedInputCnyPerMillion?: number
  outputCnyPerMillion: number
  /** Supplier-native per-million rates for cards synchronized from a pricing site. */
  inputPerMillion?: number
  cachedInputPerMillion?: number
  outputPerMillion?: number
  currency?: string
  source?: 'manual' | 'supplier-site'
  sourceUrl?: string
  sourceGroup?: string
  sourceFetchedAt?: number
  updatedAt: number
}

export interface SupplierRateRefreshResult {
  providerId: string
  providerName: string
  status: 'updated' | 'subscription' | 'unavailable' | 'failed'
  sourceUrl?: string
  importedModels: number
  message: string
}

export interface CostUsageRecord {
  id: string
  timestamp: number
  conversationId: string
  providerId: string
  providerName: string
  model: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheMissTokens: number
  modelCalls: number
  estimatedCostCny?: number
  estimatedCost?: number
  estimatedCostCurrency?: string
  providerReportedCost?: number
  providerReportedCurrency?: string
  costSource?: 'provider' | 'rate-card'
  rateCardId?: string
  pricingMode?: 'token' | 'subscription'
  pricingSourceUrl?: string
}

export interface CostUsageReport {
  generatedAt: number
  records: CostUsageRecord[]
  rateCards: ModelRateCard[]
}
