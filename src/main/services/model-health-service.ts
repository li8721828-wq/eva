export interface ModelHealthSnapshot {
  consecutiveFailures: number
  cooldownUntil?: number
  lastSuccessAt?: number
  lastFailureAt?: number
  averageLatencyMs?: number
}

interface MutableModelHealth extends ModelHealthSnapshot {
  latencySamples: number[]
}

const BASE_COOLDOWN_MS = 15_000
const MAX_COOLDOWN_MS = 5 * 60_000

/** Process-local routing health. Credentials and provider errors never leave this service. */
export class ModelHealthService {
  private readonly entries = new Map<string, MutableModelHealth>()

  isRoutable(id: string, now = Date.now()): boolean {
    const health = this.entries.get(id)
    return !health?.cooldownUntil || health.cooldownUntil <= now
  }

  snapshot(id: string): ModelHealthSnapshot | undefined {
    const health = this.entries.get(id)
    if (!health) return undefined
    const { latencySamples: _latencySamples, ...snapshot } = health
    return snapshot
  }

  recordSuccess(id: string, latencyMs: number): void {
    const health = this.get(id)
    health.consecutiveFailures = 0
    health.cooldownUntil = undefined
    health.lastSuccessAt = Date.now()
    health.latencySamples = [...health.latencySamples, Math.max(0, Math.round(latencyMs))].slice(-12)
    health.averageLatencyMs = Math.round(health.latencySamples.reduce((sum, sample) => sum + sample, 0) / health.latencySamples.length)
  }

  recordFailure(id: string): void {
    const health = this.get(id)
    health.consecutiveFailures += 1
    health.lastFailureAt = Date.now()
    const backoff = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** Math.max(0, health.consecutiveFailures - 1))
    health.cooldownUntil = Date.now() + backoff
  }

  private get(id: string): MutableModelHealth {
    let health = this.entries.get(id)
    if (!health) {
      health = { consecutiveFailures: 0, latencySamples: [] }
      this.entries.set(id, health)
    }
    return health
  }
}

export const modelHealthService = new ModelHealthService()
