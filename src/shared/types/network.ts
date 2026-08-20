export type NetworkProxyMode = 'system' | 'direct' | 'manual'

/**
 * Application-wide network routing. This is intentionally separate from an
 * individual model connection: provider requests, supplier-pricing refreshes,
 * and other Electron network traffic share this routing policy.
 */
export interface NetworkConfig {
  mode: NetworkProxyMode
  /** Electron proxy rules, for example `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`. */
  proxyRules: string
  /** Semicolon-separated hosts or CIDRs which must bypass the proxy. */
  proxyBypassRules: string
}

export interface NetworkTestResult {
  success: boolean
  url: string
  status?: number
  resolvedProxy?: string
  message: string
}

export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  mode: 'system',
  proxyRules: '',
  proxyBypassRules: '<local>',
}
