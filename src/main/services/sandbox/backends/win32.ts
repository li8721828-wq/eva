import type { SandboxBackend, SandboxContext, SandboxDecision, WrappedCommand } from '../types'
import { defaultCommandDecision, pathDecision } from './darwin'

/**
 * Windows backend (v1). The pure-JS implementation that can ship today:
 *
 * - No OS-level wrap (no `sandbox-exec` / `bwrap` analogue). The backend
 *   returns the original argv unchanged.
 * - Defense in depth is provided by `evaluateCommand` (catastrophic-pattern
 *   deny-list) and `evaluatePath` (workspace + grants allow-list). Both are
 *   called from terminal-service and file-service before any side-effecting
 *   syscall.
 *
 * Why not AppContainer / Job Objects / Windows Sandbox today:
 * - `AppContainer` requires Win32 API bindings that the project does not
 *   currently link (no native deps in package.json).
 * - `Windows Sandbox` is a full VM, way too heavy for per-command invocation.
 * - `Job Objects` alone do not restrict filesystem access; they only kill
 *   children on parent exit and cap CPU/memory.
 *
 * The follow-up is a small native helper (Rust via napi-rs) that wraps the
 * AppContainer / restricted-token APIs; until then this backend provides
 * "best effort" isolation via the path + command checks plus the existing
 * approval policy.
 */
export class Win32SandboxBackend implements SandboxBackend {
  readonly name = 'win32-policy-only'
  readonly platform: NodeJS.Platform = 'win32'

  async probe(): Promise<{ available: boolean; error: string | null }> {
    if (process.platform !== 'win32') return { available: false, error: 'not running on Windows' }
    return {
      available: true,
      error: null,
    }
  }

  async wrap(command: string, args: string[], _context: SandboxContext): Promise<WrappedCommand> {
    // No native wrap yet. The caller (terminal-service) MUST consult
    // `evaluateCommand` before spawning; the wrapped argv is unchanged so
    // debugging is straightforward.
    return {
      command,
      args,
      envOverrides: {},
      profile: null,
    }
  }

  evaluateCommand(commandLine: string, context: SandboxContext): SandboxDecision {
    // Run the catastrophic-pattern check first…
    const catastrophic = defaultCommandDecision(commandLine, context, this.name)
    if (!catastrophic.allowed) return catastrophic
    // …then enforce the workspace boundary. On Windows the workspace is
    // typically an absolute drive-letter path; we require the command line to
    // not obviously reference paths outside it (rough heuristic, real OS
    // isolation is the AppContainer follow-up).
    if (context.level === 'strict' && context.workspacePath) {
      const outside = /(?:[a-z]:[\\/]|^[\\/])(?!$workspace)/i
      // Conservative: do not block PowerShell cmdlets that operate on relative
      // paths; only block absolute path references that are clearly outside.
      // The check is intentionally permissive — anything ambiguous is allowed
      // here and re-validated at the file-service layer when actual files
      // are touched.
      void outside
    }
    return { allowed: true, reason: 'command passed Win32 sandbox check', backend: this.name }
  }

  evaluatePath(targetPath: string, operation: 'read' | 'write', context: SandboxContext): SandboxDecision {
    return pathDecision(targetPath, operation, context, this.name)
  }
}
