import net from 'net'

export function isPrivateNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::1' || normalized === '::') return true
  if (normalized.startsWith('::ffff:')) return isPrivateNetworkAddress(normalized.slice(7))
  // Unique-local fc00::/7 and link-local fe80::/10 must be matched on an IPv6
  // literal. A bare `startsWith('fc')` also fired for hostnames such as
  // `fda.gov` or `fc2.com`, which are ordinary public sites.
  if (net.isIP(normalized) === 6) {
    return normalized.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(normalized)
  }
  if (net.isIP(normalized) !== 4) return false

  const [first, second] = normalized.split('.').map(Number)
  return first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
}

export function isBlockedWebHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return normalized === 'localhost' || normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') || normalized.endsWith('.internal') ||
    isPrivateNetworkAddress(normalized)
}
