import type { ModelCapabilityProfile } from '../../shared/types/provider'

/**
 * A probe failure is not evidence that the model cannot call tools. Only a
 * response that rejects the tools field itself is. Every other failure
 * (gateway 5xx, rate limit, auth, timeout, cancellation, network) must stay
 * inconclusive so a transient incident cannot permanently block a route.
 */
export function isDefinitiveToolRejection(error: unknown): boolean {
  const status = readStatus(error)
  if (status !== 400 && status !== 404 && status !== 422) return false
  const text = errorText(error).toLowerCase()
  if (!text) return false
  const mentionsTools = /\b(?:tools?|functions?|tool_choice|function calling)\b/.test(text)
  if (!mentionsTools) return false
  return /(?:not supported|unsupported|does not support|doesn't support|unknown|invalid|not allowed|not available|unrecognized)/.test(text)
}

export function failedProbeProfile(
  inferred: ModelCapabilityProfile,
  error: unknown,
  message: string,
): ModelCapabilityProfile {
  const rejected = isDefinitiveToolRejection(error)
  return {
    ...inferred,
    supportsTools: rejected ? false : undefined,
    source: 'probed',
    probeStatus: rejected ? 'unsupported' : 'inconclusive',
    checkedAt: Date.now(),
    lastError: message,
  }
}

/**
 * Identify stored verdicts that an earlier build derived from an event which
 * never answered the tool question. Those profiles must be healed on startup;
 * otherwise a single gateway incident keeps the route blocked forever.
 */
export function isTransientProbeFailure(message: string | undefined): boolean {
  const text = `${message || ''}`.toLowerCase()
  if (!text) return false
  return /\b5\d\d\b/.test(text)
    || /timed? ?out|timeout|econn|enotfound|eai_again|socket hang up|network|fetch failed|connection error|服务暂时不可用/.test(text)
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const direct = (error as { status?: unknown }).status
  if (typeof direct === 'number') return direct
  const response = (error as { response?: { status?: unknown } }).response
  return typeof response?.status === 'number' ? response.status : undefined
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    return `${error.message} ${cause instanceof Error ? cause.message : cause ? String(cause) : ''}`.trim()
  }
  return typeof error === 'string' ? error : ''
}
