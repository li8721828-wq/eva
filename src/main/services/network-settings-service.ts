import { net, session } from 'electron'
import { DEFAULT_NETWORK_CONFIG, type NetworkConfig, type NetworkTestResult } from '../../shared/types/network'

const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204'

export function normalizeNetworkConfig(value: Partial<NetworkConfig> | undefined): NetworkConfig {
  const mode = value?.mode === 'direct' || value?.mode === 'manual' || value?.mode === 'system'
    ? value.mode
    : DEFAULT_NETWORK_CONFIG.mode
  const proxyRules = typeof value?.proxyRules === 'string' ? value.proxyRules.trim() : ''
  const proxyBypassRules = typeof value?.proxyBypassRules === 'string'
    ? value.proxyBypassRules.trim()
    : DEFAULT_NETWORK_CONFIG.proxyBypassRules

  if (mode === 'manual' && !proxyRules) {
    throw new Error('Enter a proxy address before applying manual proxy mode.')
  }
  if (proxyRules.length > 2_000 || proxyBypassRules.length > 2_000) {
    throw new Error('Proxy rules must be 2,000 characters or fewer.')
  }
  return { mode, proxyRules, proxyBypassRules }
}

export async function applyNetworkConfig(value: Partial<NetworkConfig> | undefined): Promise<NetworkConfig> {
  const config = normalizeNetworkConfig(value)
  const ses = session.defaultSession
  if (config.mode === 'system') {
    await ses.setProxy({ mode: 'system' })
  } else if (config.mode === 'direct') {
    await ses.setProxy({ mode: 'direct' })
  } else {
    await ses.setProxy({
      mode: 'fixed_servers',
      proxyRules: config.proxyRules,
      proxyBypassRules: config.proxyBypassRules,
    })
  }
  await ses.closeAllConnections()
  return config
}

function testUrl(value?: string): string {
  const url = (value || DEFAULT_TEST_URL).trim()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS test address.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('The test address must use HTTP or HTTPS.')
  }
  return parsed.toString()
}

export async function testNetworkConnection(value?: string): Promise<NetworkTestResult> {
  const url = testUrl(value)
  const resolvedProxy = await session.defaultSession.resolveProxy(url)
  try {
    let response = await net.fetch(url, { method: 'HEAD', redirect: 'follow' })
    if (response.status === 405 || response.status === 501) {
      response = await net.fetch(url, { method: 'GET', redirect: 'follow', headers: { range: 'bytes=0-0' } })
    }
    return {
      success: response.ok || (response.status >= 300 && response.status < 400),
      url,
      status: response.status,
      resolvedProxy,
      message: response.ok
        ? `Network connection succeeded (HTTP ${response.status}).`
        : `The endpoint responded with HTTP ${response.status}. The network route is reachable, but the endpoint rejected the request.`,
    }
  } catch (error) {
    return {
      success: false,
      url,
      resolvedProxy,
      message: error instanceof Error ? `Network connection failed: ${error.message}` : 'Network connection failed.',
    }
  }
}
