import type { SandboxConfig, SandboxLevel, SandboxBackendStatus } from '../../../shared/types/automation'
import type { FileAccessGrant } from '../../../shared/types/file-access'

/**
 * Inputs the backend needs to decide whether a given command/path is allowed.
 * `cwd` is the workspace path for the current conversation. `extraAllowedPaths`
 * are joined with the workspace and `fileAccessGrants` to form the allow-list.
 */
export interface SandboxContext {
  workspacePath: string
  fileAccessGrants: ReadonlyArray<FileAccessGrant>
  extraAllowedPaths: ReadonlyArray<string>
  allowNetwork: boolean
  level: SandboxLevel
}

/**
 * Result of evaluating an operation against the active sandbox. `allowed`
 * must be honored by callers; `reason` is human-readable and surfaces in the
 * tool result / approval card.
 */
export interface SandboxDecision {
  allowed: boolean
  reason: string
  /** Backend that produced the decision, for diagnostics. */
  backend: string
}

/**
 * A wrapped command ready to be passed to `node-pty.spawn` / `child_process.spawn`.
 * `command` may be empty when the backend injects itself via the first arg
 * (e.g. `sandbox-exec` on macOS). `args` is the full argv.
 */
export interface WrappedCommand {
  command: string
  args: string[]
  /** Extra env vars to set on the spawned process (e.g. cleared HOME). */
  envOverrides: Record<string, string | undefined>
  /** Profile blob the backend is using, surfaced for diagnostics. */
  profile: string | null
}

export interface SandboxBackend {
  readonly name: string
  readonly platform: NodeJS.Platform
  /**
   * Probe whether the backend is actually usable (binary on PATH, native
   * bindings present, etc.). Called once at startup and again when the user
   * flips the level in Settings.
   */
  probe(): Promise<{ available: boolean; error: string | null }>
  /**
   * Wrap a child-process argv into a sandboxed argv. Backends that cannot wrap
   * (e.g. Windows v1) should return the original argv and rely on
   * {@link evaluateCommand} / {@link evaluatePath} for policy enforcement.
   */
  wrap(command: string, args: string[], context: SandboxContext): Promise<WrappedCommand>
  /**
   * Evaluate a shell command line against the policy. Used as a safety net
   * even when the backend wraps the spawn (defense in depth).
   */
  evaluateCommand(commandLine: string, context: SandboxContext): SandboxDecision
  /**
   * Evaluate a filesystem path against the policy. `operation` is `'read'`
   * or `'write'`. Used by file-service regardless of whether the backend
   * wraps a process.
   */
  evaluatePath(targetPath: string, operation: 'read' | 'write', context: SandboxContext): SandboxDecision
}

export interface SandboxStatusReport {
  config: SandboxConfig
  backend: SandboxBackendStatus
}

/** Convenience alias so consumers don't import the shared types directly. */
export type { SandboxConfig, SandboxLevel, SandboxBackendStatus }
