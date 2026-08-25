import { describe, expect, it } from 'vitest'
import { classifyError } from '../../src/main/providers/errors'

describe('provider error classification', () => {
  it('retries a gateway connection close', () => {
    const error = classifyError(new Error('net::ERR_CONNECTION_CLOSED'), 'gateway')

    expect(error).toMatchObject({ code: 'network', retryable: true })
  })
})
