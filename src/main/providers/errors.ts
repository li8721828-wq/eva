export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'auth_failed'
      | 'rate_limited'
      | 'timeout'
      | 'network'
      | 'invalid_request'
      | 'model_not_found'
      | 'unknown',
    public readonly providerId: string,
    public readonly retryable: boolean = false
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export class AuthenticationError extends ProviderError {
  constructor(message: string, providerId: string) {
    super(message, 'auth_failed', providerId, false)
    this.name = 'AuthenticationError'
  }
}

export class RateLimitError extends ProviderError {
  constructor(
    message: string,
    providerId: string,
    public readonly retryAfterMs?: number
  ) {
    super(message, 'rate_limited', providerId, true)
    this.name = 'RateLimitError'
  }
}

export class TimeoutError extends ProviderError {
  constructor(message: string, providerId: string) {
    super(message, 'timeout', providerId, true)
    this.name = 'TimeoutError'
  }
}

export class NetworkError extends ProviderError {
  constructor(message: string, providerId: string) {
    super(message, 'network', providerId, true)
    this.name = 'NetworkError'
  }
}

export class ModelNotFoundError extends ProviderError {
  constructor(message: string, providerId: string) {
    super(message, 'model_not_found', providerId, false)
    this.name = 'ModelNotFoundError'
  }
}

export class InvalidRequestError extends ProviderError {
  constructor(message: string, providerId: string) {
    super(message, 'invalid_request', providerId, false)
    this.name = 'InvalidRequestError'
  }
}

/**
 * Classify an unknown error into a ProviderError based on common patterns.
 */
export function classifyError(err: unknown, providerId: string): ProviderError {
  if (err instanceof ProviderError) return err

  const message = err instanceof Error ? err.message : String(err)
  const status = (err as any)?.status ?? (err as any)?.statusCode
  const lowerMsg = message.toLowerCase()

  if (status === 401 || status === 403 || lowerMsg.includes('auth') || lowerMsg.includes('api key')) {
    return new AuthenticationError(message, providerId)
  }
  if (status === 429 || lowerMsg.includes('rate limit') || lowerMsg.includes('too many')) {
    const retryAfter = (err as any)?.headers?.['retry-after']
    const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined
    return new RateLimitError(message, providerId, retryMs)
  }
  if (status === 404 && lowerMsg.includes('model')) {
    return new ModelNotFoundError(message, providerId)
  }
  if (status === 400 || lowerMsg.includes('invalid')) {
    return new InvalidRequestError(message, providerId)
  }
  if (
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('timed out') ||
    lowerMsg.includes('econnaborted')
  ) {
    return new TimeoutError(message, providerId)
  }
  if (
    lowerMsg.includes('network') ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('enotfound') ||
    lowerMsg.includes('fetch failed')
  ) {
    return new NetworkError(message, providerId)
  }

  return new ProviderError(message, 'unknown', providerId, false)
}

/**
 * Retry options for withRetry wrapper.
 */
export interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Execute an async function with exponential backoff retry.
 * Retries on retryable ProviderErrors (timeout, rate_limit, network).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  providerId: string,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options }

  let lastError: unknown
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const providerErr = classifyError(err, providerId)

      if (!providerErr.retryable || attempt === opts.maxRetries) {
        throw providerErr
      }

      // Calculate delay with exponential backoff
      let delay: number
      if (providerErr instanceof RateLimitError && providerErr.retryAfterMs) {
        delay = Math.min(providerErr.retryAfterMs, opts.maxDelayMs)
      } else {
        delay = Math.min(opts.baseDelayMs * Math.pow(2, attempt), opts.maxDelayMs)
      }

      await sleep(delay)
    }
  }

  throw classifyError(lastError, providerId)
}
