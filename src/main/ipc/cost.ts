import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { ModelRateCard } from '../../shared/types/cost'
import { getStorage } from '../storage'
import { getCostUsageReport } from '../services/cost-usage-service'

function validRateCard(rateCard: ModelRateCard): boolean {
  return Boolean(rateCard.id && rateCard.providerId && rateCard.model)
    && Number.isFinite(rateCard.inputCnyPerMillion)
    && Number.isFinite(rateCard.outputCnyPerMillion)
    && rateCard.inputCnyPerMillion >= 0
    && rateCard.outputCnyPerMillion >= 0
    && (rateCard.cachedInputCnyPerMillion === undefined || (Number.isFinite(rateCard.cachedInputCnyPerMillion) && rateCard.cachedInputCnyPerMillion >= 0))
}

export function registerCostHandlers(): void {
  ipcMain.handle(IPC.COST_USAGE_REPORT, () => getCostUsageReport())
  ipcMain.handle(IPC.COST_RATE_CARDS_SAVE, (_event, rateCards: ModelRateCard[]) => {
    if (!Array.isArray(rateCards) || rateCards.some((rateCard) => !validRateCard(rateCard))) {
      throw new Error('Each model rate must include non-negative input and output rates.')
    }
    getStorage().config.set('costRateCards', rateCards)
  })
}
