import { spawn } from 'child_process'
import type { SandboxBackend, SandboxContext, SandboxDecision, WrappedCommand } from '../types'
import { buildDarwinSandboxExecProfile, type ProfileInputs } from '../profile-builder'

/**
 * macOS backend: wraps every spawned process with `sandbox-exec -p <profile>`.
 * `sandbox-exec` is shipped with every macOS install (it lives in /usr/bin) so
 * probe() does not need to check PATH — but it does still need to confirm the
 * binary actually executes on this kernel (sandbox.kext being loaded).
 */
export class DarwinSandboxExecBackend implements SandboxBackend {
  readonly name = 'darwin-sandbox-exec'
  readonly platform: NodeJS.Platform = 'darwin'

  async probe(): Promise<{ available: boolean; error: string | null }> {
    if (process.platform !== 'darwin') return { available: false, error: 'not running on macOS' }
    return new Promise<{ available: boolean; error: string | null }>((resolve) => {
      const child = spawn('sandbox-exec', ['-h'], { stdio: 'ignore' })
      child.on('error', (error) => resolve({ available: false, error: error.message }))
      child.on('exit', (code) => {
        if (code === 0 || code === null) resolve({ available: true, error: null })
        else resolve({ available: false, error: `sandbox-exec exited with code ${code}` })
      })
    })
  }

  async wrap(command: string, args: string[], context: SandboxContext): Promise<WrappedCommand> {
    const profileInputs = profileInputsFromContext(context)
    const profile = buildDarwinSandboxExecProfile(profileInputs)
    return {
      command: 'sandbox-exec',
      args: ['-p', profile, command, ...args],
      envOverrides: {},
      profile,
    }
  }

  evaluateCommand(commandLine: string, context: SandboxContext): SandboxDecision {
    // sandbox-exec already enforces the policy; this is the defense-in-depth
    // path-level check for any tool that opens a file directly (bypassing spawn).
    return defaultCommandDecision(commandLine, context, this.name)
  }

  evaluatePath(targetPath: string, operation: 'read' | 'write', context: SandboxContext): SandboxDecision {
    return pathDecision(targetPath, operation, context, this.name)
  }
}

function profileInputsFromContext(context: SandboxContext): ProfileInputs {
  return {
    workspacePath: context.workspacePath,
    extraAllowedPaths: context.extraAllowedPaths,
    allowNetwork: context.allowNetwork,
  }
}

/**
 * Path-level decision used by file-service regardless of the OS backend.
 * Returns the standard "allowed inside allowed set / denied otherwise" answer.
 */
export function pathDecision(
  targetPath: string,
  operation: 'read' | 'write',
  context: SandboxContext,
  backend: string,
): SandboxDecision {
  if (context.level === 'off') {
    return { allowed: true, reason: 'sandbox is off', backend }
  }
  const normalized = targetPath.replace(/\\/g, '/').toLowerCase()
  const allowedRoots = [...context.extraAllowedPaths, context.workspacePath]
    .filter(Boolean)
    .map((root) => root.replace(/\\/g, '/').toLowerCase())
  for (const root of allowedRoots) {
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      return { allowed: true, reason: `path is within ${root}`, backend }
    }
  }
  // Read operations also allow the Eva user-data dir and system temp.
  if (operation === 'read') {
    const readOnly = readOnlyRoots()
    for (const root of readOnly) {
      if (normalized.startsWith(root)) return { allowed: true, reason: `read-only system path: ${root}`, backend }
    }
  }
  return {
    allowed: false,
    reason: operation === 'write'
      ? `写入路径 ${targetPath} 不在沙箱允许列表内。`
      : `读取路径 ${targetPath} 不在沙箱允许列表内。`,
    backend,
  }
}

function readOnlyRoots(): string[] {
  if (process.platform === 'darwin') return ['/usr/', '/bin/', '/sbin/', '/library/', '/system/', '/private/etc/', '/private/var/', '/etc/', '/var/', '/tmp/', '/dev/']
  if (process.platform === 'linux') return ['/usr/', '/bin/', '/sbin/', '/lib', '/etc/', '/var/', '/opt/', '/tmp/', '/run/', '/sys/', '/proc/', '/dev/']
  // Windows: allow read of the Windows system directory and common read-only locations.
  // Paths are stored with forward slashes because pathDecision normalizes the target
  // path to forward slashes before comparing.
  if (process.platform === 'win32') return ['c:/windows/', 'c:/program files/', 'c:/program files (x86)/', 'c:/windows/system32/']
  return []
}

/**
 * Command-line level decision. The OS sandbox is the real enforcer; this only
 * blocks obviously catastrophic patterns as a fast pre-check (e.g. `rm -rf /`,
 * `Remove-Item -Force C:\Windows`). Used on Windows where no OS sandbox exists
 * and as defense-in-depth on every other platform.
 */
export function defaultCommandDecision(commandLine: string, context: SandboxContext, backend: string): SandboxDecision {
  if (context.level === 'off') return { allowed: true, reason: 'sandbox is off', backend }
  const lower = commandLine.toLowerCase()
  const dangerous = [
    /rm\s+-rf?\s+\/(?:\s|$)/,
    /rm\s+-rf?\s+\\(?:\s|$)/,
    /format\s+[a-z]:/i,
    /bcdedit/i,
    /reg\s+delete\s+hkey_(local_machine|current_user|users|classes_root)/i,
    /diskpart/i,
    /remove-item\s+.*-recurse.*-force.*c:\\/i,
    /del\s+\/s\s+\/q\s+c:\\/i,
    /shutdown\s+\/s/i,
  ]
  for (const pattern of dangerous) {
    if (pattern.test(lower)) {
      return { allowed: false, reason: `拒绝执行危险命令：${commandLine.slice(0, 80)}`, backend }
    }
  }
  return { allowed: true, reason: 'command passed sandbox check', backend }
}
