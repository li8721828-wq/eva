import { app } from 'electron'
import path from 'path'
import fs from 'fs'

let logFilePath: string | null = null

function getLogFilePath(): string {
  if (logFilePath) return logFilePath
  try {
    const userData = app.getPath('userData')
    const logDir = path.join(userData, 'logs')
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
    logFilePath = path.join(logDir, `eva-${new Date().toISOString().slice(0, 10)}.log`)
  } catch {
    // app may not be ready yet
    logFilePath = path.join(process.cwd(), 'eva-error.log')
  }
  return logFilePath
}

function writeLog(level: string, message: string, stack?: string): void {
  const timestamp = new Date().toISOString()
  const entry = `[${timestamp}] [${level}] ${message}${stack ? '\n' + stack : ''}\n`
  try {
    fs.appendFileSync(getLogFilePath(), entry)
  } catch {
    // Last resort: write to stderr
    process.stderr.write(entry)
  }
}

/**
 * Set up global error handlers to prevent app crashes and log errors.
 */
export function setupGlobalErrorHandlers(): void {
  process.on('uncaughtException', (error: Error) => {
    writeLog('FATAL', `Uncaught Exception: ${error.message}`, error.stack)
    console.error('[Eva] Uncaught Exception:', error)
    // Do NOT exit — keep the app alive
  })

  process.on('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? reason.stack : undefined
    writeLog('ERROR', `Unhandled Rejection: ${message}`, stack)
    console.error('[Eva] Unhandled Rejection:', reason)
  })

  process.on('warning', (warning) => {
    writeLog('WARN', `Process Warning: ${warning.message}`)
  })
}

/**
 * Retry wrapper for LLM calls with exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; baseDelay?: number; retryableErrors?: string[] }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3
  const baseDelay = options?.baseDelay ?? 1000
  const retryableErrors = options?.retryableErrors ?? [
    'rate_limit',
    'overloaded',
    'timeout',
    'ECONNRESET',
    'ETIMEDOUT',
    'socket hang up',
    'network',
    '502',
    '503',
    '529',
  ]

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const errMsg = lastError.message.toLowerCase()

      const isRetryable = retryableErrors.some((pattern) => errMsg.includes(pattern.toLowerCase()))

      if (!isRetryable || attempt === maxRetries) {
        throw lastError
      }

      // Exponential backoff with jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500
      writeLog('WARN', `Retry attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms: ${lastError.message}`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError!
}

/**
 * Convert internal errors to user-friendly messages.
 */
export function getUserFriendlyError(error: unknown): string {
  if (!error) return 'An unknown error occurred'

  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  if (lower.includes('rate_limit') || lower.includes('429')) {
    return 'The AI service is rate-limited. Please wait a moment and try again.'
  }
  if (lower.includes('overloaded') || lower.includes('503') || lower.includes('529')) {
    return 'The AI service is temporarily overloaded. Please try again in a few seconds.'
  }
  if (lower.includes('api_key') || lower.includes('authentication') || lower.includes('401')) {
    return 'Invalid API key. Please check your provider configuration in Settings.'
  }
  if (lower.includes('model') && (lower.includes('not found') || lower.includes('does not exist'))) {
    return 'The selected model is not available. Please choose a different model.'
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network')) {
    return 'Network connection failed. Please check your internet connection.'
  }
  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return 'The request timed out. The AI service may be slow or unreachable.'
  }
  if (lower.includes('context_length') || lower.includes('token')) {
    return 'The conversation is too long for the AI model. Try starting a new conversation.'
  }
  if (lower.includes('permission') || lower.includes('eacces')) {
    return 'Permission denied. Please check file/folder access rights.'
  }
  if (lower.includes('enoent')) {
    return 'File or directory not found. It may have been moved or deleted.'
  }

  return message.length > 200 ? message.slice(0, 200) + '...' : message
}
