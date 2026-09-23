import { describe, expect, it } from 'vitest'
import { formatProviderRequestFailure } from '../../src/main/services/provider-request-diagnostics'
import { classifyError } from '../../src/main/providers/errors'
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

  it('explains network failures with actionable metadata', () => {
    const message = formatProviderRequestFailure(
      Object.assign(new Error('The provider closed the connection before returning a response.'), { code: 'network', retryable: true }),
      provider,
      'deepseek-v4-flash-vision-exp',
      'chat',
    )

    // The banner and the persisted round notice both keep only this first line.
    expect(message.split('\n', 1)[0]).toBe('无法连接模型服务。检查该连接的 baseUrl、代理与 DNS 设置；若只有这个模型失败，再核对模型名称和工具调用兼容性。')
    expect(message).toContain('The provider closed the connection')
    expect(message).toContain('code=network')
    expect(message).toContain('retryable=true')
  })

  it('reports the HTTP status that caused a classified failure', () => {
    const message = formatProviderRequestFailure(
      classifyError(Object.assign(new Error('401 Authentication Fails'), { status: 401 }), 'console-go'),
      provider,
      'deepseek-v4-flash',
      'goal-step',
    )

    expect(message).toContain('status=401')
    expect(message).toContain('code=auth_failed')
  })
})
