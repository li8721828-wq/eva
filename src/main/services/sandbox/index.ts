import type { SandboxBackend, SandboxContext, SandboxDecision, SandboxStatusReport, WrappedCommand } from './types'
import { NoopSandboxBackend } from './backends/noop'
import { DarwinSandboxExecBackend } from './backends/darwin'
import { LinuxBubblewrapBackend } from './backends/linux'
import { Win32SandboxBackend } from './backends/win32'
import type { SandboxBackendStatus, SandboxConfig } from '../../../shared/types/automation'

/**
 * Process-singleton sandbox dispatcher. Picks the right backend for the current
 * platform at startup, probes it, and remembers the result. The agent runner
 * and services call `getSandboxBackend()` to get a stable reference; the
 * reference changes only when the user flips the level in Settings (rare).
 */
class SandboxDispatcher {
  private backend: SandboxBackend = new NoopSandboxBackend()
  private status: SandboxBackendStatus = {
    backend: 'noop',
    available: true,
    lastError: null,
    platform: process.platform,
    probedAt: null,
  }
  private initialized = false

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await this.refresh()
  }

  /**
   * Re-detect the backend. Called after a Settings change that may flip the
   * level, or after a backend failure. Returns the new status so the UI can
   * re-render.
   */
  async refresh(): Promise<SandboxBackendStatus> {
    const candidate = await pickBackend()
    this.backend = candidate
    const probe = await candidate.probe()
    this.status = {
      backend: candidate.name,
      available: probe.available,
      lastError: probe.error,
      platform: process.platform,
      probedAt: Date.now(),
    }
    return this.status
  }

  getBackend(): SandboxBackend {
    return this.backend
  }

  getStatus(): SandboxBackendStatus {
    return this.status
  }

  async wrap(command: string, args: string[], context: SandboxContext): Promise<WrappedCommand> {
    return this.backend.wrap(command, args, context)
  }

  evaluateCommand(commandLine: string, context: SandboxContext): SandboxDecision {
    return this.backend.evaluateCommand(commandLine, context)
  }

  evaluatePath(targetPath: string, operation: 'read' | 'write', context: SandboxContext): SandboxDecision {
    return this.backend.evaluatePath(targetPath, operation, context)
  }

  buildStatusReport(config: SandboxConfig): SandboxStatusReport {
    return { config, backend: this.status }
  }
}

async function pickBackend(): Promise<SandboxBackend> {
  switch (process.platform) {
    case 'darwin': return new DarwinSandboxExecBackend()
    case 'linux': return new LinuxBubblewrapBackend()
    case 'win32': return new Win32SandboxBackend()
    default: return new NoopSandboxBackend()
  }
}

const dispatcher = new SandboxDispatcher()

export async function initializeSandbox(): Promise<SandboxBackendStatus> {
  return dispatcher.initialize().then(() => dispatcher.getStatus())
}

export async function refreshSandbox(): Promise<SandboxBackendStatus> {
  return dispatcher.refresh()
}

export function getSandboxStatus(): SandboxBackendStatus {
  return dispatcher.getStatus()
}

export function getSandboxStatusReport(config: SandboxConfig): SandboxStatusReport {
  return dispatcher.buildStatusReport(config)
}

/** Wrap an argv via the active backend. */
export async function wrapCommandForSandbox(
  command: string,
  args: string[],
  context: SandboxContext,
): Promise<WrappedCommand> {
  return dispatcher.wrap(command, args, context)
}

/** Defense-in-depth: check a shell command line before spawn. */
export function evaluateSandboxCommand(commandLine: string, context: SandboxContext): SandboxDecision {
  return dispatcher.evaluateCommand(commandLine, context)
}

/** Defense-in-depth: check a filesystem path before read/write. */
export function evaluateSandboxPath(
  targetPath: string,
  operation: 'read' | 'write',
  context: SandboxContext,
): SandboxDecision {
  return dispatcher.evaluatePath(targetPath, operation, context)
}

export function getSandboxBackend(): SandboxBackend {
  return dispatcher.getBackend()
}

// Re-export types for consumers that import from the index rather than ./types.
export type { SandboxContext, SandboxDecision, SandboxStatusReport } from './types'
