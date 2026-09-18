/**
 * TypeScript thin wrapper around the `eva_sandbox` native module.
 *
 * The Rust crate (under `crates/eva-sandbox/`) compiles to `eva_sandbox.node`
 * via napi-rs.  This module re-exports the typed API used by the sandbox
 * service in `services/sandbox/index.ts`.
 *
 * Loading strategy:
 *  - `require('../../../native')` — the generated loader at `<repo>/native/`
 *    picks the right platform-specific `.node` binary.
 *
 * The Rust crate exposes JSON-serialized results; we parse on this side so
 * the TypeScript types stay stable without `napi-rs` generating `.d.ts`
 * bindings (which would require an extra build step in our CI).
 */

// ---------------------------------------------------------------------------
// Native binding loader
// ---------------------------------------------------------------------------

type NativeModule = {
  resolveSandboxPolicyJs: (
    approvalPolicy: string,
    sandbox: { level?: string; allowNetwork?: boolean; extraAllowedPaths?: string[]; extraCommandPatterns?: string[] },
    mode: string,
  ) => string

  buildProfiles: (inputs: {
    workspacePath: string
    extraAllowedPaths?: string[]
    allowNetwork?: boolean
  }) => string

  pathDecisionJs: (
    targetPath: string,
    operation: string,
    context: SandboxContext,
    backend: string,
  ) => string

  defaultCommandDecisionJs: (
    commandLine: string,
    context: SandboxContext,
    backend: string,
  ) => string

  probeDarwin: () => Promise<string>
  probeLinux: () => Promise<string>
  probeNoop: () => string

  wrapDarwin: (
    command: string,
    args: string[],
    context: SandboxContext,
  ) => string

  wrapLinux: (
    command: string,
    args: string[],
    context: SandboxContext,
  ) => string
}

let native: NativeModule | null = null
let loadError: string | null = null

try {
  // `native/index.cjs` is the napi-rs generated loader.  It picks the right
  // platform-specific binary (eva_sandbox.<triple>.node) and re-exports the
  // camelCase FFI functions.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  native = require('../../../../native') as NativeModule
} catch (err) {
  loadError = (err as Error).message
  console.error(
    `[sandbox/native] Failed to load eva_sandbox native module: ${loadError}\n` +
      `Rebuild with: cd crates/eva-sandbox && cargo build --release`,
  )
}

function assertLoaded(): NativeModule {
  if (!native) {
    throw new Error(
      `eva_sandbox native module not available. Rebuild Rust crate.\n` +
        `Original error: ${loadError ?? 'unknown'}`,
    )
  }
  return native
}

// ---------------------------------------------------------------------------
// TypeScript re-exports (mirror src/shared/types/*)
// ---------------------------------------------------------------------------

export type ToolApprovalPolicy = 'off' | 'safe' | 'strict' | 'paranoid'
export type SandboxLevel = 'off' | 'permissive' | 'strict'
export type AgentMode = 'normal' | 'plan' | 'auto'
export type FsOperation = 'read' | 'write'

export interface FileAccessGrant {
  path: string
  access: 'read' | 'read-write'
}

export interface SandboxContext {
  workspacePath: string
  fileAccessGrants?: ReadonlyArray<FileAccessGrant>
  extraAllowedPaths?: ReadonlyArray<string>
  allowNetwork?: boolean
  level: SandboxLevel
}

export interface SandboxDecision {
  allowed: boolean
  reason: string
  backend: string
}

export interface WrappedCommand {
  command: string
  args: string[]
  envOverrides: Record<string, string | undefined>
  profile: string | null
}

export interface SandboxBackendStatus {
  backend: string
  available: boolean
  lastError: string | null
  platform: NodeJS.Platform
  probedAt: number | null
}

export interface ResolvedSandboxPolicy {
  effectiveApprovalPolicy: ToolApprovalPolicy
  effectiveSandboxLevel: SandboxLevel
  sandboxActive: boolean
  effectiveMode: Exclude<AgentMode, 'auto'>
  note: string | null
}

export interface SandboxConfig {
  level: SandboxLevel
  allowNetwork: boolean
  extraAllowedPaths: string[]
  extraCommandPatterns: string[]
}

// ---------------------------------------------------------------------------
// Helper: JSON wrapper for napi return values
// ---------------------------------------------------------------------------

function parseDecision(json: string): SandboxDecision {
  const obj = JSON.parse(json) as SandboxDecision & { error?: string }
  if (obj.error) {
    // Rust side returned an error wrapper.  Reflect it as a deny decision
    // so callers can still surface the reason to the user.
    return {
      allowed: false,
      reason: `[rust] ${obj.error}`,
      backend: 'rust-error',
    }
  }
  return obj
}

// ---------------------------------------------------------------------------
// Pure policy resolution (delegated to Rust)
// ---------------------------------------------------------------------------

export function resolveSandboxPolicy(
  approvalPolicy: ToolApprovalPolicy,
  sandbox: SandboxConfig,
  mode: AgentMode = 'normal',
): ResolvedSandboxPolicy {
  const n = assertLoaded()
  const json = n.resolveSandboxPolicyJs(approvalPolicy, sandbox, mode)
  return JSON.parse(json) as ResolvedSandboxPolicy
}

// ---------------------------------------------------------------------------
// Path / command evaluation (delegated to Rust)
// ---------------------------------------------------------------------------

export function pathDecision(
  targetPath: string,
  operation: FsOperation,
  context: SandboxContext,
  backend: string,
): SandboxDecision {
  const n = assertLoaded()
  const json = n.pathDecisionJs(targetPath, operation, context, backend)
  return parseDecision(json)
}

export function defaultCommandDecision(
  commandLine: string,
  context: SandboxContext,
  backend: string,
): SandboxDecision {
  const n = assertLoaded()
  const json = n.defaultCommandDecisionJs(commandLine, context, backend)
  return parseDecision(json)
}

// ---------------------------------------------------------------------------
// Profile builder (delegated to Rust)
// ---------------------------------------------------------------------------

export function buildProfiles(
  workspacePath: string,
  extraAllowedPaths: ReadonlyArray<string>,
  allowNetwork: boolean,
): { darwinSandboxExecProfile: string; bubblewrapArgs: string[] } {
  const n = assertLoaded()
  const json = n.buildProfiles({
    workspacePath,
    extraAllowedPaths: [...extraAllowedPaths],
    allowNetwork,
  })
  return JSON.parse(json)
}

// ---------------------------------------------------------------------------
// Async backend probes (delegated to Rust)
// ---------------------------------------------------------------------------

export async function probeDarwinBackend(): Promise<{ available: boolean; error: string | null }> {
  const n = assertLoaded()
  const json = await n.probeDarwin()
  return JSON.parse(json)
}

export async function probeLinuxBackend(): Promise<{ available: boolean; error: string | null }> {
  const n = assertLoaded()
  const json = await n.probeLinux()
  return JSON.parse(json)
}

// ---------------------------------------------------------------------------
// Argv wrappers (delegated to Rust)
// ---------------------------------------------------------------------------

export async function wrapDarwinCommands(
  command: string,
  args: string[],
  context: SandboxContext,
): Promise<WrappedCommand> {
  const n = assertLoaded()
  const json = n.wrapDarwin(command, args, context)
  return JSON.parse(json) as WrappedCommand
}

export async function wrapLinuxCommands(
  command: string,
  args: string[],
  context: SandboxContext,
): Promise<WrappedCommand> {
  const n = assertLoaded()
  const json = n.wrapLinux(command, args, context)
  return JSON.parse(json) as WrappedCommand
}
