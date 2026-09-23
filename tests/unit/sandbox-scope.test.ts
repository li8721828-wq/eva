import { afterEach, describe, expect, it } from 'vitest'
import {
  closeSandboxScope,
  currentSandboxScope,
  openSandboxScope,
  resetSandboxScopes,
} from '../../src/main/services/sandbox/scope'
import type { SandboxContext } from '../../src/main/services/sandbox/types'

function scope(level: SandboxContext['level'], workspacePath = 'C:/workspace'): SandboxContext {
  return { workspacePath, fileAccessGrants: [], extraAllowedPaths: [], allowNetwork: false, level }
}

afterEach(() => {
  resetSandboxScopes()
})

describe('sandbox scopes', () => {
  it('exposes the only open scope', () => {
    openSandboxScope(scope('permissive'))
    expect(currentSandboxScope()?.level).toBe('permissive')
  })

  it('keeps a still-running run guarded after a concurrent run finishes', () => {
    const first = openSandboxScope(scope('strict'))
    const second = openSandboxScope(scope('strict', 'D:/other'))

    closeSandboxScope(first)

    expect(currentSandboxScope()).toEqual(scope('strict', 'D:/other'))
    closeSandboxScope(second)
  })

  it('returns null once every scope is closed', () => {
    const first = openSandboxScope(scope('strict'))
    const second = openSandboxScope(scope('permissive'))

    closeSandboxScope(second)
    closeSandboxScope(first)

    expect(currentSandboxScope()).toBeNull()
  })

  it('applies the strictest active scope so concurrency never weakens enforcement', () => {
    openSandboxScope(scope('off'))
    openSandboxScope(scope('strict', 'D:/strict'))
    openSandboxScope(scope('permissive', 'D:/permissive'))

    expect(currentSandboxScope()?.level).toBe('strict')
    expect(currentSandboxScope()?.workspacePath).toBe('D:/strict')
  })

  it('ignores a closed token and a null context', () => {
    const token = openSandboxScope(scope('permissive'))
    closeSandboxScope(token)

    const blocked = openSandboxScope(null)
    expect(currentSandboxScope()).toBeNull()
    closeSandboxScope(blocked)
  })
})
