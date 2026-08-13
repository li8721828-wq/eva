import { describe, expect, it } from 'vitest'
import { ModelRouter } from '../../src/main/services/model-router'
import { ModelHealthService } from '../../src/main/services/model-health-service'
import type { ModelPool } from '../../src/shared/types/model-pool'

const pools: ModelPool[] = [
  { id: 'development', name: 'Development', entries: [
    { id: 'reasoning-backup', name: 'Reasoning backup', providerId: 'backup', model: 'r2', capabilities: ['reasoning'], priority: 20, enabled: true },
    { id: 'reasoning-primary', name: 'Reasoning primary', providerId: 'primary', model: 'r1', capabilities: ['reasoning', 'language'], priority: 10, enabled: true },
    { id: 'code-offline', name: 'Code offline', providerId: 'offline', model: 'code', capabilities: ['code'], priority: 1, enabled: false },
  ] },
  { id: 'research', name: 'Research', entries: [
    { id: 'research-language', name: 'Research language', providerId: 'research', model: 'search', capabilities: ['language'], priority: 1, enabled: true },
  ] },
]

describe('ModelRouter', () => {
  it('returns the lowest-priority-number available connection and ordered fallbacks', () => {
    const route = new ModelRouter(pools, (entry) => entry.providerId !== 'backup').resolve({ poolId: 'development', capability: 'reasoning' })
    expect(route.primary?.id).toBe('reasoning-primary')
    expect(route.fallbacks).toEqual([])
  })

  it('does not route disabled or unavailable connections', () => {
    const route = new ModelRouter(pools, () => true).resolve({ poolId: 'development', capability: 'code' })
    expect(route.primary).toBeUndefined()
    expect(route.fallbacks).toEqual([])
  })

  it('maps agent preferences to model capabilities', () => {
    expect(ModelRouter.capabilityForPreference('coding')).toBe('code')
    expect(ModelRouter.capabilityForPreference('reasoning')).toBe('reasoning')
    expect(ModelRouter.capabilityForPreference('research')).toBe('language')
  })

  it('does not cross route into another agent pool', () => {
    const route = new ModelRouter(pools, () => true).resolve({ poolId: 'research', capability: 'language' })
    expect(route.primary?.id).toBe('research-language')
  })

  it('skips a connection in cooldown and uses its eligible fallback', () => {
    const health = new ModelHealthService()
    health.recordFailure('reasoning-primary')
    const route = new ModelRouter(pools, () => true, health).resolve({ poolId: 'development', capability: 'reasoning' })
    expect(route.primary?.id).toBe('reasoning-backup')
  })
})
