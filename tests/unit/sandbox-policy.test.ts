import { describe, expect, it } from 'vitest'
import { resolveSandboxPolicy } from '../../src/main/services/sandbox/policy'
import type { SandboxConfig, ToolApprovalPolicy } from '../../src/shared/types/automation'

function sandbox(level: 'off' | 'permissive' | 'strict'): SandboxConfig {
  return { level, allowNetwork: true, extraAllowedPaths: [], extraCommandPatterns: [] }
}

function check(approvalPolicy: ToolApprovalPolicy, level: SandboxConfig) {
  return resolveSandboxPolicy(approvalPolicy, level)
}

describe('resolveSandboxPolicy', () => {
  it('off: sandbox inactive regardless of approval policy', () => {
    for (const policy of ['off', 'safe', 'strict', 'paranoid'] as ToolApprovalPolicy[]) {
      const result = check(policy, sandbox('off'))
      expect(result.sandboxActive).toBe(false)
      expect(result.effectiveSandboxLevel).toBe('off')
      expect(result.effectiveApprovalPolicy).toBe(policy)
    }
  })

  it('permissive: approval policy off upgrades to safe', () => {
    const result = check('off', sandbox('permissive'))
    expect(result.sandboxActive).toBe(true)
    expect(result.effectiveSandboxLevel).toBe('permissive')
    expect(result.effectiveApprovalPolicy).toBe('safe')
    expect(result.note).not.toBeNull()
  })

  it('permissive: existing approval policy preserved', () => {
    for (const policy of ['safe', 'strict', 'paranoid'] as ToolApprovalPolicy[]) {
      const result = check(policy, sandbox('permissive'))
      expect(result.effectiveApprovalPolicy).toBe(policy)
      expect(result.effectiveSandboxLevel).toBe('permissive')
    }
  })

  it('strict: always upgrades off approval to safe', () => {
    const result = check('off', sandbox('strict'))
    expect(result.effectiveApprovalPolicy).toBe('safe')
    expect(result.effectiveSandboxLevel).toBe('strict')
    expect(result.sandboxActive).toBe(true)
  })

  it('note is null when sandbox is off', () => {
    const result = check('off', sandbox('off'))
    expect(result.note).toBeNull()
  })

  it('note is present when sandbox is on and approval was upgraded', () => {
    const result = check('off', sandbox('strict'))
    expect(result.note).toContain('沙箱')
    expect(result.note).toContain('safe')
  })

  it('note is present when sandbox is on but approval was already non-off', () => {
    const result = check('safe', sandbox('strict'))
    expect(result.note).toContain('沙箱')
    expect(result.note).toContain('审批通过')
  })
})
