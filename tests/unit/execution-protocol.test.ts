import { describe, expect, it } from 'vitest'
import { createExecutionEnvelope } from '../../src/main/tools'

describe('execution protocol', () => {
  it('creates a structured observation envelope with stable required fields', () => {
    const envelope = createExecutionEnvelope('observation', 'observed', { controls: 3 }, {
      snapshot: { id: 'desktop_1', revision: 4, scope: 'desktop', capturedAt: '2026-08-13T00:00:00.000Z' },
    })
    expect(envelope.protocolVersion).toBe('1')
    expect(envelope.operationId).toMatch(/^op_/)
    expect(envelope.status).toBe('observed')
    expect(envelope.snapshot?.revision).toBe(4)
  })
})
