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
  return `${message}\n\n[Request diagnostics: source=${source}; provider=${provider.name} (${provider.id}); type=${provider.type}; model=${model}; baseUrl=${baseUrl}]`
}
