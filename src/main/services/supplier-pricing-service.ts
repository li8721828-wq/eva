import type { ModelRateCard, SupplierRateRefreshResult } from '../../shared/types/cost'
import type { ProviderConfigEntry } from '../../shared/types/provider'
import { net } from 'electron'
import { getStorage } from '../storage'

const APILIO_PRICE_URL = 'https://apilio.ai/api/models/price'
const APILIO_MODELS_URL = 'https://apilio.ai/models'
const QUICKROUTER_PRICE_URL = 'https://doc.quickrouter.ai/docs/group-pricing.html'
const VOLCENGINE_CODING_PLAN_URL = 'https://developer.volcengine.com/articles/7616633140483719219'

type JsonRecord = Record<string, unknown>

interface ProviderRefresh {
  result: SupplierRateRefreshResult
  rateCards: ModelRateCard[]
}

const PRICING_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
const inFlightRefreshes = new Map<string, Promise<void>>()
const lastRefreshes = new Map<string, number>()

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function configuredModels(provider: ProviderConfigEntry): string[] {
  return Array.from(new Set([
    provider.defaultModel,
    ...(provider.models || []).map((model) => model.id),
  ].filter((model): model is string => Boolean(model?.trim()))))
}

function supplierRateCard(
  provider: ProviderConfigEntry,
  model: string,
  rates: { input: number; cachedInput?: number; output: number; currency: string },
  sourceUrl: string,
  sourceGroup?: string,
): ModelRateCard {
  const now = Date.now()
  return {
    id: `supplier-rate-${provider.id}-${model}`.replace(/[^a-zA-Z0-9_.-]/g, '-'),
    providerId: provider.id,
    model,
    // Kept for compatibility with old persisted cards. Native fields take precedence.
    inputCnyPerMillion: 0,
    cachedInputCnyPerMillion: 0,
    outputCnyPerMillion: 0,
    inputPerMillion: rates.input,
    cachedInputPerMillion: rates.cachedInput,
    outputPerMillion: rates.output,
    currency: rates.currency.toUpperCase(),
    source: 'supplier-site',
    sourceUrl,
    sourceGroup,
    sourceFetchedAt: now,
    updatedAt: now,
  }
}

function subscriptionResult(provider: ProviderConfigEntry): ProviderRefresh {
  return {
    result: {
      providerId: provider.id,
      providerName: provider.name,
      status: 'subscription',
      sourceUrl: VOLCENGINE_CODING_PLAN_URL,
      importedModels: 0,
      message: 'This connection uses a Coding Plan subscription. Eva will show subscription quota status instead of inventing a per-token charge.',
    },
    rateCards: [],
  }
}

function isVolcengineCodingPlan(provider: ProviderConfigEntry): boolean {
  const endpoint = `${provider.baseUrl || ''} ${provider.name}`.toLowerCase()
  return endpoint.includes('ark.cn-') && endpoint.includes('/api/coding') || endpoint.includes('coding plan')
}

function isApilio(provider: ProviderConfigEntry): boolean {
  return `${provider.baseUrl || ''} ${provider.name}`.toLowerCase().includes('apilio')
}

function isQuickRouter(provider: ProviderConfigEntry): boolean {
  return `${provider.baseUrl || ''} ${provider.name}`.toLowerCase().includes('quickrouter')
}

function modelIdFromSiteModel(entry: JsonRecord): string | undefined {
  for (const key of ['id', 'key', 'model', 'model_id', 'name']) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function parseApilioRateCards(provider: ProviderConfigEntry, payload: unknown): ModelRateCard[] {
  const root = isRecord(payload) && isRecord(payload.data) ? payload.data : payload
  const modelsValue = isRecord(root) ? root.models : undefined
  const entries = Array.isArray(modelsValue)
    ? modelsValue.filter(isRecord)
    : isRecord(modelsValue) ? Object.values(modelsValue).filter(isRecord) : []
  const selectedModels = new Set(configuredModels(provider))
  const cards: ModelRateCard[] = []

  for (const entry of entries) {
    const model = modelIdFromSiteModel(entry)
    if (!model || !selectedModels.has(model)) continue
    const groupPrices = isRecord(entry.group_price) ? entry.group_price : undefined
    if (!groupPrices) continue
    const configuredGroup = provider.pricingGroup?.trim()
    const groupName = configuredGroup && isRecord(groupPrices[configuredGroup])
      ? configuredGroup
      : isRecord(groupPrices.default) ? 'default' : undefined
    if (!groupName) continue
    const price = groupPrices[groupName]
    if (!isRecord(price)) continue
    const input = asNumber(price.price)
    const completionRatio = asNumber(entry.completion_ratio) ?? 1
    const cacheRatio = asNumber(price.cache_hits_ratio)
    const currency = typeof price.currency === 'string' ? price.currency : typeof entry.currency === 'string' ? entry.currency : 'USD'
    if (input === undefined || completionRatio < 0 || (cacheRatio !== undefined && cacheRatio < 0)) continue
    cards.push(supplierRateCard(provider, model, {
      input,
      ...(cacheRatio !== undefined ? { cachedInput: input * cacheRatio } : {}),
      output: input * completionRatio,
      currency,
    }, APILIO_MODELS_URL, groupName))
  }
  return cards
}

function apilioGroupsForConfiguredModels(provider: ProviderConfigEntry, payload: unknown): string[] {
  const root = isRecord(payload) && isRecord(payload.data) ? payload.data : payload
  const modelsValue = isRecord(root) ? root.models : undefined
  const entries = Array.isArray(modelsValue) ? modelsValue.filter(isRecord) : isRecord(modelsValue) ? Object.values(modelsValue).filter(isRecord) : []
  const models = new Set(configuredModels(provider))
  const groups = new Set<string>()
  for (const entry of entries) {
    if (!models.has(modelIdFromSiteModel(entry) || '')) continue
    if (!isRecord(entry.group_price)) continue
    Object.keys(entry.group_price).forEach((group) => groups.add(group))
  }
  return [...groups].sort((left, right) => left.localeCompare(right))
}

function firstNumber(record: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const direct = asNumber(record[key])
    if (direct !== undefined) return direct
  }
  return undefined
}

function quickRouterCards(provider: ProviderConfigEntry, payload: unknown): ModelRateCard[] {
  const root = isRecord(payload) ? payload : {}
  const entriesValue = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : []
  const selectedModels = new Set(configuredModels(provider))
  const cards: ModelRateCard[] = []
  for (const raw of entriesValue) {
    if (!isRecord(raw)) continue
    const model = modelIdFromSiteModel(raw)
    if (!model || !selectedModels.has(model)) continue
    const pricing = isRecord(raw.pricing) ? raw.pricing : raw
    // Only accept explicit per-million fields. Gateways frequently expose per-token
    // values under similarly named properties, and silently guessing the unit is unsafe.
    const input = firstNumber(pricing, ['input_per_million', 'prompt_per_million', 'input_price_per_million'])
    const output = firstNumber(pricing, ['output_per_million', 'completion_per_million', 'output_price_per_million'])
    const cachedInput = firstNumber(pricing, ['cached_input_per_million', 'cache_read_per_million'])
    const currency = typeof pricing.currency === 'string' ? pricing.currency : 'USD'
    if (input === undefined || output === undefined) continue
    cards.push(supplierRateCard(provider, model, { input, output, ...(cachedInput === undefined ? {} : { cachedInput }), currency }, QUICKROUTER_PRICE_URL))
  }
  return cards
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers)
  headers.set('accept', 'application/json')
  const response = await net.fetch(url, {
    method: init?.method,
    headers: Object.fromEntries(headers.entries()),
    body: init?.body,
    signal: init?.signal,
  })
  if (!response.ok) throw new Error(`Supplier returned HTTP ${response.status}`)
  return response.json()
}

async function refreshApilio(provider: ProviderConfigEntry): Promise<ProviderRefresh> {
  const payload = await fetchJson(APILIO_PRICE_URL)
  const cards = parseApilioRateCards(provider, payload)
  const groups = apilioGroupsForConfiguredModels(provider, payload)
  return {
    result: {
      providerId: provider.id,
      providerName: provider.name,
      status: cards.length ? 'updated' : 'unavailable',
      sourceUrl: APILIO_MODELS_URL,
      importedModels: cards.length,
      message: cards.length
        ? `Imported ${cards.length} connection-specific rate card(s) from Apilio's Model Hub.`
        : groups.length
          ? `Apilio returned pricing groups for this connection’s model: ${groups.join(', ')}. Set one as the connection’s Supplier pricing group before syncing; Eva will not guess the route.`
          : 'Apilio returned pricing data, but none matched this connection’s configured model and pricing group. No estimate was created.',
    },
    rateCards: cards,
  }
}

async function refreshQuickRouter(provider: ProviderConfigEntry): Promise<ProviderRefresh> {
  const baseUrl = (provider.baseUrl || 'https://api.quickrouter.ai/v1').replace(/\/$/, '')
  const cards = quickRouterCards(provider, await fetchJson(`${baseUrl}/models`, provider.apiKey ? { headers: { authorization: `Bearer ${provider.apiKey}` } } : undefined))
  return {
    result: {
      providerId: provider.id,
      providerName: provider.name,
      status: cards.length ? 'updated' : 'unavailable',
      sourceUrl: QUICKROUTER_PRICE_URL,
      importedModels: cards.length,
      message: cards.length
        ? `Imported ${cards.length} connection-specific rate card(s) returned by QuickRouter.`
        : 'QuickRouter returned its model catalog, but no explicit per-million rate fields for this connection. No estimate was created rather than guessing a unit or route price.',
    },
    rateCards: cards,
  }
}

export async function refreshSupplierRateCards(providers: ProviderConfigEntry[]): Promise<{ results: SupplierRateRefreshResult[]; rateCards: ModelRateCard[] }> {
  const enabledProviders = providers.filter((provider) => provider.isEnabled)
  const refreshed = await Promise.all(enabledProviders.map(async (provider): Promise<ProviderRefresh> => {
    try {
      if (isVolcengineCodingPlan(provider)) return subscriptionResult(provider)
      if (isApilio(provider)) return await refreshApilio(provider)
      if (isQuickRouter(provider)) return await refreshQuickRouter(provider)
      return {
        result: {
          providerId: provider.id,
          providerName: provider.name,
          status: 'unavailable',
          importedModels: 0,
          message: 'This supplier does not expose a stable machine-readable price endpoint configured for this connection yet. No rate was guessed from a global model price.',
        },
        rateCards: [],
      }
    } catch (error) {
      return {
        result: {
          providerId: provider.id,
          providerName: provider.name,
          status: 'failed',
          importedModels: 0,
          message: error instanceof Error ? `Could not refresh supplier pricing: ${error.message}` : 'Could not refresh supplier pricing.',
        },
        rateCards: [],
      }
    }
  }))
  return { results: refreshed.map((item) => item.result), rateCards: refreshed.flatMap((item) => item.rateCards) }
}

/**
 * Lazily synchronize pricing before a connection is used. This deliberately
 * refreshes a supplier connection, not a model globally, and coalesces
 * concurrent requests for the same connection.
 */
export async function ensureProviderPricing(providerId: string): Promise<void> {
  const running = inFlightRefreshes.get(providerId)
  if (running) return running

  const storage = getStorage()
  const provider = storage.config.getProvider(providerId)
  if (!provider?.isEnabled) return
  const now = Date.now()
  const savedCards = storage.config.get('costRateCards')
  const latestSavedRefresh = Math.max(0, ...savedCards
    .filter((card) => card.providerId === providerId && card.source === 'supplier-site')
    .map((card) => card.sourceFetchedAt || 0))
  if (now - Math.max(lastRefreshes.get(providerId) || 0, latestSavedRefresh) < PRICING_REFRESH_INTERVAL_MS) return

  const task = (async () => {
    const { results, rateCards } = await refreshSupplierRateCards([provider])
    lastRefreshes.set(providerId, Date.now())
    const result = results[0]
    if (!result || result.status !== 'updated') return
    const retained = storage.config.get('costRateCards').filter((card) => card.source !== 'supplier-site' || card.providerId !== providerId)
    storage.config.set('costRateCards', [...retained, ...rateCards])
  })()
  inFlightRefreshes.set(providerId, task)
  try {
    await task
  } finally {
    inFlightRefreshes.delete(providerId)
  }
}
