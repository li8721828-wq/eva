import { describe, expect, it } from 'vitest'
import { summarizeRuntimeActivity } from '../../src/renderer/lib/runtime-introspection'

describe('summarizeRuntimeActivity', () => {
  it('groups runtime entries and highlights only error events', () => {
    const summary = summarizeRuntimeActivity([
      { id: '1', timestamp: 1, category: 'agent', action: 'agent.started', status: 'info', summary: 'Started' },
      { id: '2', timestamp: 2, category: 'tool', action: 'tool.completed', status: 'success', summary: 'Completed' },
      { id: '3', timestamp: 3, category: 'tool', action: 'tool.completed', status: 'error', summary: 'Failed' },
    ])

    expect(summary).toEqual({ errors: 1, byCategory: { agent: 1, tool: 2 } })
  })
})
