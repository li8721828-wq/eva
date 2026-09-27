import fs from 'fs'
import { isIP } from 'net'

export interface RemoteTransportValidationInput {
  loopbackOnly: boolean
  publicBaseUrl?: string
  tlsCertPath?: string
  tlsKeyPath?: string
}

export function normalizeListenHost(value: string | undefined): string {
  const host = value?.trim() || '127.0.0.1'
  if (host.includes('/') || host.includes(' ')) throw new Error('App Server 监听地址无效。')
  return host
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  if (normalized === 'localhost' || normalized === '::1') return true
  if (isIP(normalized) === 4) return normalized.split('.')[0] === '127'
  return false
}

export function validateRemoteTransport(input: RemoteTransportValidationInput): void {
  const publicBaseUrl = input.publicBaseUrl?.trim()
  if (publicBaseUrl) {
    const parsed = new URL(publicBaseUrl)
    if (parsed.protocol !== 'https:') throw new Error('公网地址必须使用 https://。')
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('公网地址不能包含凭据、查询参数或片段。')
  }
  if (input.loopbackOnly) return
  if (!publicBaseUrl) throw new Error('远程模式需要填写 HTTPS 公网地址。')
  if (!input.tlsCertPath?.trim() || !input.tlsKeyPath?.trim()) {
    throw new Error('远程模式需要填写 TLS 证书和私钥路径。')
  }
}

export function resolveBaseUrl(input: {
  scheme: 'http' | 'https'
  host: string
  port: number
  publicBaseUrl?: string
  loopbackOnly: boolean
}): string {
  if (input.publicBaseUrl?.trim()) return input.publicBaseUrl.trim().replace(/\/+$/, '')
  const host = input.host.includes(':') && !input.host.startsWith('[') ? `[${input.host}]` : input.host
  return `${input.scheme}://${host}:${input.port}`
}

export function readRequiredPem(filePath: string | undefined, label: string): Buffer {
  const normalized = filePath?.trim()
  if (!normalized) throw new Error(`远程模式缺少 TLS ${label}路径。`)
  try {
    return fs.readFileSync(normalized)
  } catch (error: any) {
    throw new Error(`无法读取 TLS ${label}文件：${error?.message ?? String(error)}`)
  }
}
