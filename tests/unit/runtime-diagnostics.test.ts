import { describe, expect, it } from 'vitest'
import { diagnoseRuntime } from '../../src/main/services/runtime-diagnostics'

describe('diagnoseRuntime', () => {
  it('reports evidence-backed errors without proposing an automatic mutation', () => {
    const report = diagnoseRuntime({
      agents: [{ id: 'agent-1', name: 'Coder', description: '', role: 'coder', systemPrompt: '', providerId: 'provider-1', model: 'm1', modelPoolIds: ['missing-pool'], tools: ['missing-tool'], maxIterations: 10, temperature: 0.5, isBuiltIn: true, createdAt: 1, updatedAt: 1 }],
      tools: [{ name: 'inspect_runtime', description: '', parameters: {} }],
      plugins: [],
      providers: [{ id: 'provider-1', name: 'Primary', type: 'openai', apiKey: 'secret', isEnabled: true }],
      modelPools: [{ id: 'pool-1', name: 'Primary pool', entries: [{ id: 'route-1', name: 'Stale route', providerId: 'missing-provider', model: 'm1', capabilities: ['code'], priority: 1, enabled: true }] }],
      activity: [{ id: 'event-1', timestamp: 1, category: 'tool', action: 'tool.completed', status: 'error', summary: 'Failed' }],
    })

    expect(report.status).toBe('attention')
    expect(report.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining(['recent-runtime-errors', 'missing-route-provider', 'missing-agent-model-pool', 'stale-agent-tools']))
    expect(report.constraints.join(' ')).toContain('Read-only diagnosis')
  })

  it('keeps a healthy result when the focused area has no findings', () => {
    const report = diagnoseRuntime({ agents: [], tools: [], plugins: [], providers: [], modelPools: [], activity: [] }, 'errors')

    expect(report.status).toBe('healthy')
    expect(report.findings).toEqual([])
  })
})
