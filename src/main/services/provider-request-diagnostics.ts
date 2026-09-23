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

/**
 * Both places a provider failure reaches the user keep only its first line: the
 * error banner is truncated to it and the persisted round notice stores it as
 * the explanation. So the first line has to state the cause and the next action
 * in the user's language, while the raw provider text and the routing evidence
 * stay below for diagnosis.
 */
const FAILURE_GUIDANCE: Record<string, { headline: string; advice: string }> = {
  network: {
    headline: '无法连接模型服务',
    advice: '检查该连接的 baseUrl、代理与 DNS 设置；若只有这个模型失败，再核对模型名称和工具调用兼容性。',
  },
  timeout: {
    headline: '模型服务响应超时',
    advice: '重试本轮；持续超时请改用响应更快的模型或连接。',
  },
  auth_failed: {
    headline: '模型服务拒绝了鉴权',
    advice: '在 Cost Center 检查 API Key、账号权限和接口地址。',
  },
  rate_limited: {
    headline: '模型服务触发限流',
    advice: '等待供应商的限流窗口结束后重试，或切换到其他模型/连接。',
  },
  model_not_found: {
    headline: '所选模型在该连接上不存在',
    advice: '在 Cost Center 核对模型 ID 后重试。',
  },
  invalid_request: {
    headline: '模型服务拒绝了本次请求',
    advice: '确认该模型支持当前启用的工具、推理参数和消息格式。',
  },
  unknown: {
    headline: '模型服务返回异常',
    advice: '查看供应商返回信息并确认模型路由配置。',
  },
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
  const guidance = FAILURE_GUIDANCE[code] || FAILURE_GUIDANCE.unknown
  return `${guidance.headline}。${guidance.advice}\n\n供应商返回信息：${message}\n\n[Request diagnostics: source=${source}; phase=${phase}; provider=${provider.name} (${provider.id}); type=${provider.type}; model=${model}; baseUrl=${baseUrl}; code=${code}; status=${status}; retryable=${retryable}]`
}
