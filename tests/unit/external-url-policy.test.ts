import { describe, expect, it } from 'vitest'
import { isSafeExternalUrl } from '../../src/main/services/external-url-policy'

describe('external URL policy', () => {
  it('permits normal web and mail destinations', () => {
    expect(isSafeExternalUrl('https://example.com/docs')).toBe(true)
    expect(isSafeExternalUrl('http://127.0.0.1:3000')).toBe(true)
    expect(isSafeExternalUrl('mailto:eva@example.com')).toBe(true)
  })

  it('rejects executable, local-file, and malformed destinations', () => {
    expect(isSafeExternalUrl('file:///C:/Users/user/secret.txt')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('not a URL')).toBe(false)
  })
})
