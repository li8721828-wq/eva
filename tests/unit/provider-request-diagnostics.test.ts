import { describe, expect, it } from 'vitest'
import { formatProviderRequestFailure } from '../../src/main/services/provider-request-diagnostics'
import type { LLMProvider } from '../../src/main/providers/base-provider'

const provider = {
  id: 'console-go',
  name: 'Console Go',
  type: 'custom',
  getConnectionDiagnostics: () => ({ baseUrl: 'https://user:secret@console.example.com/v1?api_key=secret#fragment' }),
} as unknown as LLMProvider

describe('provider request diagnostics', () => {
  it('identifies the failed route without leaking URL credentials', () => {
    const message = formatProviderRequestFailure(
      new Error('401 Authentication Fails'),
      provider,
      'deepseek-v4-flash',
      'goal-step',
    )

    expect(message).toContain('source=goal-step')
    expect(message).toContain('provider=Console Go (console-go)')
    expect(message).toContain('model=deepseek-v4-flash')
    expect(message).toContain('baseUrl=https://console.example.com/v1')
    expect(message).not.toContain('secret')
    expect(message).not.toContain('api_key')
  })
})
