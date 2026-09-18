import type { SandboxBackend, SandboxContext, SandboxDecision, WrappedCommand } from '../types'

/**
 * No-op backend. Used when the user has explicitly set `sandbox.level === 'off'`
 * or when the platform-specific backend failed its `probe()`. Always reports
 * `available` so the UI can distinguish "user disabled" from "platform missing".
 */
export class NoopSandboxBackend implements SandboxBackend {
  readonly name = 'noop'
  readonly platform = process.platform

  async probe(): Promise<{ available: boolean; error: string | null }> {
    return { available: true, error: null }
  }

  async wrap(command: string, args: string[], _context: SandboxContext): Promise<WrappedCommand> {
    return {
      command,
      args,
      envOverrides: {},
      profile: null,
    }
  }

  evaluateCommand(_commandLine: string, _context: SandboxContext): SandboxDecision {
    return { allowed: true, reason: 'sandbox is off', backend: this.name }
  }

  evaluatePath(_targetPath: string, _operation: 'read' | 'write', _context: SandboxContext): SandboxDecision {
    return { allowed: true, reason: 'sandbox is off', backend: this.name }
  }
}
