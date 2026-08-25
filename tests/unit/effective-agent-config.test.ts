import { describe, expect, it } from 'vitest'
import { resolveEffectiveAgentConfig } from '../../src/main/services/effective-agent-config'
import type { AgentConfig } from '../../src/shared/types/agent'

const baseAgent: AgentConfig = {
  id: 'agent-1',
  name: 'Coding Assistant',
  description: '',
  role: 'coder',
  systemPrompt: '',
  providerId: 'saved-provider',
  model: 'saved-model',
  tools: [],
  maxIterations: 10,
  temperature: 0.2,
  isBuiltIn: true,
  createdAt: 1,
  updatedAt: 1,
}

describe('resolveEffectiveAgentConfig', () => {
  it('makes built-in agents inherit the active conversation connection', () => {
    const effective = resolveEffectiveAgentConfig(baseAgent, {
      providerId: 'console-go',
      model: 'deepseek-v4-flash',
    })

    expect(effective).toMatchObject({
      providerId: 'console-go',
      model: 'deepseek-v4-flash',
    })
    expect(baseAgent).toMatchObject({
      providerId: 'saved-provider',
      model: 'saved-model',
    })
  })

  it('keeps an explicit custom-agent connection unchanged', () => {
    const customAgent = { ...baseAgent, isBuiltIn: false }

    expect(resolveEffectiveAgentConfig(customAgent, {
      providerId: 'console-go',
      model: 'deepseek-v4-flash',
    })).toBe(customAgent)
  })
})
