import { describe, expect, it } from 'vitest'
import { buildRuntimeSnapshot, type RuntimeInspectionSource } from '../../src/main/tools/runtime-inspection-tools'

const source: RuntimeInspectionSource = {
  listAgents: async () => [{
    id: 'agent-1', name: 'Inspector', description: 'Runtime inspector', role: 'researcher', systemPrompt: 'Never expose this prompt.', model: 'm1', providerId: 'provider-1', tools: ['inspect_runtime'], maxIterations: 10, temperature: 0.2, isBuiltIn: true, createdAt: 1, updatedAt: 1,
  }],
  listPlugins: () => [{
    id: 'plugin-1', name: 'Plugin', description: 'Plugin description', version: '1.0.0', category: 'utility', permissions: ['network'], configuration: [{ key: 'token', label: 'Token', type: 'secret', required: true }], settings: { token: 'secret-value' }, enabled: true, source: 'local', installedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }],
  listProviders: () => [{ id: 'provider-1', name: 'Provider', type: 'openai', apiKey: 'super-secret-key', isEnabled: true, defaultModel: 'm1', models: [{ id: 'm1', name: 'Model 1' }] }],
  listModelPools: () => [{ id: 'pool-1', name: 'Primary', entries: [{ id: 'route-1', name: 'Route', providerId: 'provider-1', model: 'm1', capabilities: ['code'], priority: 1, enabled: true }] }],
  listTools: () => [{ name: 'inspect_runtime', description: 'Inspect runtime', parameters: { type: 'object' } }],
  listActivity: async () => [{ id: 'activity-1', timestamp: 1, category: 'tool', action: 'inspect_runtime', status: 'success', summary: 'Runtime inspected', conversationId: 'conversation-1' }],
}

describe('buildRuntimeSnapshot', () => {
  it('returns a redacted overview without plugin settings, prompts, or API keys', async () => {
    const snapshot = await buildRuntimeSnapshot(source, 'all', 'conversation-1')
    const serialized = JSON.stringify(snapshot)

    expect(snapshot).toMatchObject({ overview: { agents: 1, enabledPlugins: 1, registeredTools: 1, enabledModelRoutes: 1 } })
    expect(serialized).not.toContain('super-secret-key')
    expect(serialized).not.toContain('secret-value')
    expect(serialized).not.toContain('Never expose this prompt.')
    expect(snapshot.activity).toEqual([{ timestamp: 1, category: 'tool', action: 'inspect_runtime', status: 'success', summary: 'Runtime inspected' }])
  })

  it('does not return activity outside a conversation scope', async () => {
    const snapshot = await buildRuntimeSnapshot(source, 'activity')

    expect(snapshot.activity).toEqual([])
    expect(snapshot.activityNote).toContain('No conversation scope')
  })
})
