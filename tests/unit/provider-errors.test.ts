import { describe, expect, it } from 'vitest'
import { classifyError } from '../../src/main/providers/errors'

describe('provider error classification', () => {
  it('retries a gateway connection close', () => {
    const error = classifyError(new Error('net::ERR_CONNECTION_CLOSED'), 'gateway')

    expect(error).toMatchObject({ code: 'network', retryable: true })
    expect(error.message).toContain('closed the connection')
  })

  it('preserves the HTTP status that produced the failure', () => {
    const unauthorized = classifyError(Object.assign(new Error('401 Authentication Fails'), { status: 401 }), 'gateway')
    expect(unauthorized).toMatchObject({ code: 'auth_failed', status: 401 })

    const throttled = classifyError(Object.assign(new Error('Too many requests'), { statusCode: 429 }), 'gateway')
    expect(throttled).toMatchObject({ code: 'rate_limited', status: 429 })

    const invalid = classifyError(Object.assign(new Error('Bad request body'), { status: 400 }), 'gateway')
    expect(invalid).toMatchObject({ code: 'invalid_request', status: 400 })
  })

  it('leaves the status unset when the failure carries none', () => {
    expect(classifyError(new Error('Something unexpected happened'), 'gateway').status).toBeUndefined()
  })
})
