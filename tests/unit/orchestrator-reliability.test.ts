import { describe, expect, it, vi } from 'vitest'
import { GoalPlanner } from '../../src/main/agent-engine/goal-planner'
import { TeamOrchestrator } from '../../src/main/agent-engine/team-orchestrator'
import { ContextManager } from '../../src/main/agent-engine/context'
import { ToolRegistry } from '../../src/main/tools'
import type { AgentConfig } from '../../src/shared/types/agent'
import type { GoalProgress, TaskPlan } from '../../src/shared/types/task'

vi.mock('../../src/main/services/supplier-pricing-service', () => ({ ensureProviderPricing: async () => undefined }))

function fixture() {
  const agent: AgentConfig = {
    id: 'coder', name: 'Coder', role: 'coder', description: '', systemPrompt: 'Perform the action.',
    model: 'test-model', providerId: 'test', tools: ['execute_command'], maxIterations: 5,
    temperature: 0, isBuiltIn: false, createdAt: 0, updatedAt: 0,
  }
  let requests = 0
  const execute = vi.fn(async () => 'applied')
  const registry = new ToolRegistry()
  registry.register({ definition: { name: 'execute_command', description: '', parameters: {} }, execute })
  const provider = {
    id: 'test', name: 'Test', type: 'custom' as const, supportsReasoning: () => false,
    chatComplete: async () => ({ content: 'The action requires verification after a network interruption.' }),
    chat: () => ({ async *[Symbol.asyncIterator]() {
      requests += 1
      if (requests % 2 === 0) throw new Error('network connection closed')
      yield { finishReason: 'tool_calls', toolCalls: [{ index: 0, id: `command-${requests}`, name: 'execute_command', arguments: '{}' }] }
    } }),
  }
  const config = {
    agentConfig: agent, provider: provider as never, toolRegistry: registry,
    contextManager: new ContextManager(), workspacePath: process.cwd(),
    fileService: {} as never, terminalService: {} as never,
  }
  return { agent, execute, config, provider, requests: () => requests }
}

describe('orchestrator side-effect recovery', () => {
  it('does not retry an entire Goal step after an action and does not mark the failed Goal complete', async () => {
    const { config, execute, requests } = fixture()
    const planner = new GoalPlanner({ ...config, maxSteps: 1 })
    const progress: GoalProgress = {
      goal: 'Perform the action', steps: [{ id: 'step', index: 0, description: 'Perform the action', status: 'pending' }],
      currentStepIndex: 0, totalSteps: 1, status: 'pending', startedAt: 0,
    }
    const events = []
    for await (const event of planner.run({ goal: progress.goal, maxSteps: 1, timeout: 60_000, autoAdjust: false }, progress)) events.push(event)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(requests()).toBe(2)
    expect(events.some((event) => event.type === 'step_retrying')).toBe(false)
    expect(events.find((event) => event.type === 'done')).toMatchObject({ progress: { status: 'failed', steps: [{ status: 'failed' }] } })
  })

  it('does not retry a Team subtask after its action was already admitted', async () => {
    const { agent, config, execute, requests, provider } = fixture()
    const orchestrator = new TeamOrchestrator({ ...config, leader: agent, workers: [agent], providerForAgent: () => provider as never })
    const plan: TaskPlan = {
      id: 'plan', goal: 'Perform the action', createdAt: 0, status: 'pending',
      subtasks: [{ id: 'task', planId: 'plan', title: 'Perform the action', description: 'Perform the requested action', status: 'pending', assignedAgentId: agent.id, requiredTools: ['execute_command'], dependencies: [] }],
    }
    const events = []
    for await (const event of orchestrator.run({ goal: plan.goal, plan })) events.push(event)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(requests()).toBe(2)
    expect(events.some((event) => event.type === 'task_failed')).toBe(true)
    expect(events.find((event) => event.type === 'error')?.error).toContain('did not complete')
    expect(events.some((event) => event.type === 'summary')).toBe(false)
  })
})
