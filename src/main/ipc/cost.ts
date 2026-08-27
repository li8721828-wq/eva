import { trustedIpcMain as ipcMain } from './trusted-ipc'
import { IPC } from '../../shared/ipc-channels'
import type { ModelRateCard } from '../../shared/types/cost'
import { getStorage } from '../storage'
import { getCostUsageReport } from '../services/cost-usage-service'
import { refreshSupplierRateCards } from '../services/supplier-pricing-service'

function validRateCard(rateCard: ModelRateCard): boolean {
  const input = rateCard.inputPerMillion ?? rateCard.inputCnyPerMillion
  const output = rateCard.outputPerMillion ?? rateCard.outputCnyPerMillion
  const cachedInput = rateCard.cachedInputPerMillion ?? rateCard.cachedInputCnyPerMillion
  return Boolean(rateCard.id && rateCard.providerId && rateCard.model)
    && Number.isFinite(input)
    && Number.isFinite(output)
    && input >= 0
    && output >= 0
    && (cachedInput === undefined || (Number.isFinite(cachedInput) && cachedInput >= 0))
}

export function registerCostHandlers(): void {
  ipcMain.handle(IPC.COST_USAGE_REPORT, () => getCostUsageReport())
  ipcMain.handle(IPC.COST_RATE_CARDS_SAVE, (_event, rateCards: ModelRateCard[]) => {
    if (!Array.isArray(rateCards) || rateCards.some((rateCard) => !validRateCard(rateCard))) {
      throw new Error('Each model rate must include non-negative input and output rates.')
    }
    getStorage().config.set('costRateCards', rateCards)
  })
  ipcMain.handle(IPC.COST_RATE_CARDS_REFRESH, async () => {
    const storage = getStorage()
    const { results, rateCards } = await refreshSupplierRateCards(storage.config.getProviders())
    const refreshedProviderIds = new Set(results.filter((result) => result.status === 'updated').map((result) => result.providerId))
    const retained = storage.config.get('costRateCards').filter((card) => card.source !== 'supplier-site' || !refreshedProviderIds.has(card.providerId))
    storage.config.set('costRateCards', [...retained, ...rateCards])
    return results
  })
}
