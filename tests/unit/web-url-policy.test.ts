import { describe, expect, it } from 'vitest'
import { isBlockedWebHostname, isPrivateNetworkAddress } from '../../src/main/tools/web-url-policy'

describe('web URL network policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.2',
    '172.16.4.2',
    '192.168.1.3',
    '169.254.2.3',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ])('recognizes private or loopback address %s', (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public address %s', (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(false)
  })

  it.each(['localhost', 'service.localhost', 'printer.local', 'admin.internal', '127.0.0.1'])('blocks local hostname %s', (hostname) => {
    expect(isBlockedWebHostname(hostname)).toBe(true)
  })

  it('allows a public hostname', () => {
    expect(isBlockedWebHostname('www.example.com')).toBe(false)
  })
})
