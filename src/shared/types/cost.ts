export interface ModelRateCard {
  id: string
  providerId: string
  model: string
  inputCnyPerMillion: number
  cachedInputCnyPerMillion?: number
  outputCnyPerMillion: number
  updatedAt: number
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
  rateCardId?: string
}

export interface CostUsageReport {
  generatedAt: number
  records: CostUsageRecord[]
  rateCards: ModelRateCard[]
}
