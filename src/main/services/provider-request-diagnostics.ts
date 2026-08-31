import type { LLMProvider } from '../providers/base-provider'

export type ProviderRequestSource = 'chat' | 'goal-plan' | 'goal-step' | 'model-pool'

function safeBaseUrl(value?: string): string {
  if (!value) return '(provider default)'
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return '(invalid or unavailable)'
  }
}

/** Adds routing evidence to a provider failure without exposing credentials. */
export function formatProviderRequestFailure(
  error: unknown,
  provider: LLMProvider,
  model: string,
  source: ProviderRequestSource,
): string {
  const message = error instanceof Error ? error.message : String(error)
  const baseUrl = safeBaseUrl(provider.getConnectionDiagnostics?.().baseUrl)
  const code = typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'unknown'
  const retryable = typeof (error as { retryable?: unknown })?.retryable === 'boolean' ? String((error as { retryable: boolean }).retryable) : 'unknown'
  const status = typeof (error as { status?: unknown })?.status === 'number' ? String((error as { status: number }).status) : 'none'
  const phase = (error as { phase?: unknown })?.phase === 'stream' ? 'stream' : 'request'
  const hint = code === 'network'
    ? '检查 baseUrl、代理/DNS、网关状态；若仅该模型失败，再检查模型名和工具调用兼容性。'
    : code === 'invalid_request'
      ? '检查模型是否支持当前工具、推理参数和消息格式。'
      : code === 'auth_failed'
        ? '检查 API Key、账号权限和接口地址。'
        : code === 'rate_limited'
          ? '等待供应商限流窗口结束或切换模型/供应商。'
          : '查看供应商返回信息并确认模型路由配置。'
  return `${message}\n\n[Request diagnostics: source=${source}; phase=${phase}; provider=${provider.name} (${provider.id}); type=${provider.type}; model=${model}; baseUrl=${baseUrl}; code=${code}; status=${status}; retryable=${retryable}]\n排查建议：${hint}`
}
