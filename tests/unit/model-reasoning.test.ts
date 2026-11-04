import { describe, expect, it, vi } from 'vitest'
import { modelReasoningCapability, reasoningCapabilityForModel, reasoningRequest, selectedReasoning, supportsReasoningSelection } from '../../src/shared/model-reasoning'
import { AgentRunner } from '../../src/main/agent-engine/agent-runner'
import { ContextManager } from '../../src/main/agent-engine/context'
import { ToolRegistry } from '../../src/main/tools'
import type { ChatParams } from '../../src/shared/types/provider'

vi.mock('../../src/main/services/supplier-pricing-service', () => ({ ensureProviderPricing: async () => {} }))
vi.mock('../../src/main/services/usage-pricing-service', () => ({ resolveConnectionPricingMode: () => ({}), resolveRateCardUsageCost: () => ({}) }))

describe('model reasoning preferences', () => {
  it('uses each API family capability instead of advertising the same levels everywhere', () => {
    expect(modelReasoningCapability('deepseek', 'deepseek-flash')).toMatchObject({ efforts: ['low', 'high', 'max'], canDisable: true })
    expect(modelReasoningCapability('openai', 'o3')).toMatchObject({ efforts: ['low', 'medium', 'high'], canDisable: false })
    expect(modelReasoningCapability('anthropic', 'claude-sonnet-4-20250514')?.mode).toBe('anthropic-budget')
    expect(modelReasoningCapability('anthropic', 'claude-opus-4-7')?.mode).toBe('anthropic-adaptive')
    expect(modelReasoningCapability('custom', 'unconfirmed-gateway-model')).toBeUndefined()
    expect(modelReasoningCapability('custom', 'claude-opus-4-7')).toBeUndefined()
    expect(modelReasoningCapability('custom', 'private', { mode: 'wrong', efforts: 'high' } as any)).toBeUndefined()
    expect(supportsReasoningSelection('none', modelReasoningCapability('openai', 'o3'))).toBe(false)
    expect(supportsReasoningSelection('medium', modelReasoningCapability('deepseek', 'deepseek-flash'))).toBe(false)
  })
  it('honors route metadata and an explicit unsupported declaration', () => {
    const profile = { supportsReasoning: true, reasoning: { mode: 'openai-effort', efforts: ['high', 'xhigh'], canDisable: false } } as any
    expect(reasoningCapabilityForModel('custom', 'private-model', [{ id: 'private-model', name: 'Private', capabilities: profile }])?.efforts).toEqual(['high', 'xhigh'])
    expect(reasoningCapabilityForModel('custom', 'deepseek-flash', [{ id: 'deepseek-flash', name: 'DS', capabilities: { ...profile, supportsReasoning: false } }])).toBeUndefined()
    expect(reasoningCapabilityForModel('custom', 'deepseek-flash', [{ id: 'deepseek-flash', name: 'DS', capabilities: { source: 'probed', supportsReasoning: false, supportsTools: true } as any }])?.efforts).toEqual(['low', 'high', 'max'])
    expect(reasoningCapabilityForModel('custom', 'deepseek-flash', [{ id: 'deepseek-flash', name: 'DS', capabilities: { source: 'probed', reasoningSource: 'declared', supportsReasoning: false } as any }])).toBeUndefined()
    expect(selectedReasoning('deepseek', 'deepseek-flash', [{ id: 'deepseek-flash', name: 'DS', reasoningSelection: 'medium' }])).toBe('default')
    expect(reasoningRequest('default')).toBeUndefined()
    expect(reasoningRequest('none')).toEqual({ enabled: false, effort: 'none' })
  })
  it('passes the chosen level through the Eva runner independently from process visibility', async () => {
    const requests: ChatParams[] = []
    const runner = new AgentRunner({
      agentConfig: { id: 'reasoning', name: 'Reasoning', role: 'coder', tools: [], model: 'test', providerId: 'test', maxIterations: 2, systemPrompt: '', temperature: 0, showThinking: false, processOutput: 'detailed' } as any,
      provider: { id: 'test', name: 'Test', type: 'custom', supportsReasoning: () => true, getReasoningSelection: () => 'high', async *chat(params: ChatParams) { requests.push(params); yield { content: 'Done.', finishReason: 'stop' as const } } } as any,
      toolRegistry: new ToolRegistry(), contextManager: new ContextManager(), workspacePath: process.cwd(), fileService: {} as any, terminalService: {} as any,
    })
    for await (const _event of runner.run({ messages: [], newMessage: { id: 'u', conversationId: 'r', role: 'user', content: 'Answer.', timestamp: 0 } })) { /* real runner */ }
    expect(requests[0].reasoning).toEqual({ enabled: true, effort: 'high' })
  })
})
