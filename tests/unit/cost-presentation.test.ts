import { describe, expect, it } from 'vitest'
import { estimatedCost } from '../../src/renderer/lib/cost-presentation'

describe('cost presentation', () => {
  it('keeps missing prices distinct from explicit zero prices', () => {
    expect(estimatedCost([])).toBeUndefined()
    expect(estimatedCost([{}, {}])).toBeUndefined()
    expect(estimatedCost([{ estimatedCostCny: 0 }, {}])).toBe(0)
  })
  it('sums only the known portion of a partially priced period', () => {
    expect(estimatedCost([{}, { estimatedCostCny: 2 }, { estimatedCostCny: 3 }])).toBe(5)
  })
})
