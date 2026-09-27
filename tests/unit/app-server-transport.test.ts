import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isLoopbackHost,
  normalizeListenHost,
  readRequiredPem,
  resolveBaseUrl,
  validateRemoteTransport,
} from '../../src/main/services/app-server/transport'

const temporaryFiles: string[] = []

afterEach(() => {
  while (temporaryFiles.length) {
    const file = temporaryFiles.pop()!
    try { fs.unlinkSync(file) } catch { /* best effort cleanup */ }
  }
})

describe('App Server transport profile', () => {
  it('keeps loopback addresses local and treats public addresses as remote', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.0.0.42')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.20')).toBe(false)
  })

  it('requires HTTPS and both PEM paths for remote mode', () => {
    expect(() => validateRemoteTransport({ loopbackOnly: true })).not.toThrow()
    expect(() => validateRemoteTransport({ loopbackOnly: true, publicBaseUrl: 'https://tunnel.example.com' })).not.toThrow()
    expect(() => validateRemoteTransport({ loopbackOnly: true, publicBaseUrl: 'http://tunnel.example.com' })).toThrow('https://')
    expect(() => validateRemoteTransport({ loopbackOnly: false })).toThrow('HTTPS 公网地址')
    expect(() => validateRemoteTransport({ loopbackOnly: false, publicBaseUrl: 'http://eva.example.com', tlsCertPath: 'cert', tlsKeyPath: 'key' })).toThrow('https://')
    expect(() => validateRemoteTransport({ loopbackOnly: false, publicBaseUrl: 'https://eva.example.com', tlsCertPath: 'cert' })).toThrow('私钥')
    expect(() => validateRemoteTransport({ loopbackOnly: false, publicBaseUrl: 'https://user:pass@eva.example.com', tlsCertPath: 'cert', tlsKeyPath: 'key' })).toThrow('凭据')
  })

  it('builds local and public endpoint origins separately', () => {
    expect(resolveBaseUrl({ scheme: 'http', host: '127.0.0.1', port: 8787, loopbackOnly: true })).toBe('http://127.0.0.1:8787')
    expect(resolveBaseUrl({ scheme: 'http', host: '127.0.0.1', port: 8787, publicBaseUrl: 'https://tunnel.example.com/', loopbackOnly: true })).toBe('https://tunnel.example.com')
    expect(resolveBaseUrl({ scheme: 'https', host: '0.0.0.0', port: 8787, publicBaseUrl: 'https://eva.example.com/', loopbackOnly: false })).toBe('https://eva.example.com')
  })

  it('reads the configured PEM file and reports a useful path error', () => {
    const file = path.join(os.tmpdir(), `eva-test-cert-${Date.now()}-${Math.random()}.pem`)
    temporaryFiles.push(file)
    fs.writeFileSync(file, 'CERTIFICATE')
    expect(readRequiredPem(file, '证书').toString('utf8')).toBe('CERTIFICATE')
    expect(() => readRequiredPem(path.join(os.tmpdir(), 'eva-missing-cert.pem'), '证书')).toThrow('无法读取 TLS 证书文件')
  })
})
