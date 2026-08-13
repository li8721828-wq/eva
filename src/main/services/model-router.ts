import type { ModelCapability, ModelPool, ModelPoolEntry, ModelRouteRequest, ModelRouteResult } from '../../shared/types/model-pool'
import { modelHealthService, type ModelHealthService } from './model-health-service'

export class ModelRouter {
  constructor(
    private readonly pools: ModelPool[],
    private readonly isAvailable: (entry: ModelPoolEntry) => boolean,
    private readonly health: ModelHealthService = modelHealthService,
  ) {}

  resolve(request: ModelRouteRequest): ModelRouteResult {
    const excluded = new Set(request.excludeIds || [])
    const pool = request.poolId ? this.pools.find((item) => item.id === request.poolId) : undefined
    const matches = (pool?.entries || [])
      .filter((entry) => entry.enabled && !excluded.has(entry.id) && entry.capabilities.includes(request.capability) && this.isAvailable(entry) && this.health.isRoutable(entry.id))
      .sort((left, right) => left.priority - right.priority || (this.health.snapshot(left.id)?.averageLatencyMs || 0) - (this.health.snapshot(right.id)?.averageLatencyMs || 0) || left.name.localeCompare(right.name))
    return { primary: matches[0], fallbacks: matches.slice(1) }
  }

  static capabilityForPreference(preference?: 'reasoning' | 'coding' | 'research' | 'fast'): ModelCapability {
    if (preference === 'reasoning') return 'reasoning'
    if (preference === 'coding') return 'code'
    return 'language'
  }
}
