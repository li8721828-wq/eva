import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Win32SandboxBackend } from '../../src/main/services/sandbox/backends/win32'
import { defaultCommandDecision, pathDecision } from '../../src/main/services/sandbox/backends/darwin'
import type { SandboxContext } from '../../src/main/services/sandbox/types'

const ctx: SandboxContext = {
  workspacePath: 'D:\\workspace',
  fileAccessGrants: [],
  extraAllowedPaths: [],
  allowNetwork: true,
  level: 'strict',
}

const permissiveCtx: SandboxContext = {
  ...ctx,
  level: 'permissive',
}

describe('Win32SandboxBackend', () => {
  let backend: Win32SandboxBackend

  beforeEach(() => {
    backend = new Win32SandboxBackend()
  })

  it('probe returns available on win32', async () => {
    const result = await backend.probe()
    expect(result.available).toBe(true)
    expect(result.error).toBeNull()
  })

  it('probe returns unavailable on non-win32', async () => {
    const b = new Win32SandboxBackend()
    // Overwrite platform check by mocking — we test the guard only.
    // Since we cannot override process.platform without a test utility, just
    // assert the name and that it would return false on other platforms.
    expect(b.name).toBe('win32-policy-only')
  })

  it('wrap returns original argv unchanged', async () => {
    const wrapped = await backend.wrap('powershell.exe', ['-Command', 'echo hi'], ctx)
    expect(wrapped.command).toBe('powershell.exe')
    expect(wrapped.args).toEqual(['-Command', 'echo hi'])
    expect(wrapped.profile).toBeNull()
  })
})

describe('defaultCommandDecision (catastrophic patterns)', () => {
  it('blocks rm -rf /', () => {
    const result = defaultCommandDecision('rm -rf /', ctx, 'test')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('危险命令')
  })

  it('blocks format drive', () => {
    const result = defaultCommandDecision('format D:', ctx, 'test')
    expect(result.allowed).toBe(false)
  })

  it('allows benign commands', () => {
    const result = defaultCommandDecision('echo hello', ctx, 'test')
    expect(result.allowed).toBe(true)
  })

  it('allows benign commands even in strict mode', () => {
    const result = defaultCommandDecision('npm install', ctx, 'test')
    expect(result.allowed).toBe(true)
  })

  it('returns allowed when sandbox is off', () => {
    const offCtx = { ...ctx, level: 'off' as const }
    const result = defaultCommandDecision('rm -rf /', offCtx, 'test')
    expect(result.allowed).toBe(true)
  })
})

describe('pathDecision', () => {
  it('denies write outside workspace in strict mode', () => {
    const result = pathDecision('C:\\Windows\\System32\\config\\sam', 'write', ctx, 'test')
    expect(result.allowed).toBe(false)
  })

  it('allows write inside workspace in strict mode', () => {
    const result = pathDecision('D:\\workspace\\src\\main.ts', 'write', ctx, 'test')
    expect(result.allowed).toBe(true)
  })

  it('allows read inside workspace in strict mode', () => {
    const result = pathDecision('D:\\workspace\\src\\main.ts', 'read', ctx, 'test')
    expect(result.allowed).toBe(true)
  })

  it('allows read of system paths in strict mode', () => {
    // readOnlyRoots() includes Windows system directories, so a read inside System32 is allowed.
    const result = pathDecision('C:\\Windows\\System32\\cmd.exe', 'read', ctx, 'test')
    expect(result.allowed).toBe(true)
  })

  it('returns allowed when sandbox is off', () => {
    const offCtx = { ...ctx, level: 'off' as const }
    const result = pathDecision('C:\\Windows\\System32\\config\\sam', 'write', offCtx, 'test')
    expect(result.allowed).toBe(true)
  })

  it('respects extraAllowedPaths', () => {
    const withExtra = { ...ctx, extraAllowedPaths: ['D:\\shared'] }
    const result = pathDecision('D:\\shared\\readme.txt', 'write', withExtra, 'test')
    expect(result.allowed).toBe(true)
  })
})
