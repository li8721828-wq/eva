import { describe, expect, it } from 'vitest'
import { goalStepIterationBudget } from '../../src/main/agent-engine/goal-planner'

describe('goalStepIterationBudget', () => {
  it('starts read-only investigation steps with a compact budget', () => {
    expect(goalStepIterationBudget({ description: 'Inspect the project structure and analyze the affected files.' }, 100)).toEqual({
      initialIterations: 16,
      extensionIterations: 12,
      maxIterations: 100,
    })
  })

  it('gives repair and verification work a larger initial budget', () => {
    expect(goalStepIterationBudget({ description: 'Fix the failing test, rebuild, and verify the result.' }, 100)).toEqual({
      initialIterations: 36,
      extensionIterations: 16,
      maxIterations: 100,
    })
  })

  it('never exceeds the Agent-configured or global safety ceiling', () => {
    expect(goalStepIterationBudget({ description: 'Implement the feature.' }, 15)).toEqual({
      initialIterations: 15,
      extensionIterations: 12,
      maxIterations: 15,
    })
    expect(goalStepIterationBudget({ description: '修复测试失败并验证。' }, 300)).toEqual({
      initialIterations: 36,
      extensionIterations: 16,
      maxIterations: 100,
    })
  })
})
