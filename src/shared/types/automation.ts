export type HiddenCapabilityId = 'team' | 'task' | 'goal' | 'plan' | 'spec'

export interface HiddenCapabilityConfig {
  enabled: boolean
  autoInvoke: boolean
}

/**
 * When should the local chat flow ask the user to approve a tool call?
 *
 * - `off`: never ask. The existing in-agent tool allowlist is the only fence
 *   (matches today's behavior for ordinary chats).
 * - `safe`: ask only for `write_file`, `edit_file`, `execute_command`,
 *   `write_terminal`, and any browser-control / MCP tool. Read-only tools are
 *   auto-approved. (Default, mirrors Codex's `workspace_write` sandbox.)
 * - `strict`: ask for every tool that is not strictly read-only, including
 *   `read_terminal`. (Mirrors Codex's `read_only` sandbox.)
 * - `paranoid`: ask for every tool call. (Match-for-match with Codex's
 *   prompt-for-everything mode used in PR-style review workflows.)
 */
export type ToolApprovalPolicy = 'off' | 'safe' | 'strict' | 'paranoid'

export interface ToolApprovalConfig {
  /** Active policy for the conversation or the current chat runner. */
  policy: ToolApprovalPolicy
  /** How long (ms) to wait for an approval decision before treating it as a denial. */
  timeoutMs: number
}

/**
 * Status returned by the App-Server introspection / control plane. Shared
 * between main and renderer to keep the preload contract typed without
 * importing main-process modules from the web bundle.
 */
export interface AppServerAcpStatus {
  /** Whether the `/acp` WebSocket was mounted when this server started. */
  enabled: boolean
  /** Path on the loopback host; a client connects to `ws://<host>:<port><path>`. */
  path: string
  /** False only while debugging a client that cannot send an `Authorization` header yet. */
  requireAuth: boolean
  connections: number
}

export interface AppServerStatus {
  running: boolean
  host: string
  port: number | null
  bearerToken: string | null
  startedAt: number | null
  lastError: string | null
  /** Always `true` for the loopback-only profile. */
  loopbackOnly: true
  connections: number
  acp?: AppServerAcpStatus
}

/**
 * Transport preferences for the loopback App-Server. There is deliberately no
 * host field: the server binds `127.0.0.1` and nothing else. A phone reaches it
 * through `adb reverse`, which terminates the connection on this machine, so
 * exposing a port is not a prerequisite for remote clients.
 */
export interface AppServerConfig {
  /**
   * Port to try before falling back to a free one. `adb reverse` needs a number
   * that survives a restart, which a random high port does not give.
   */
  preferredPort: number | null
  /**
   * Whether the `/acp` WebSocket must carry the bearer token. Turning this off
   * is a debugging convenience for a client that cannot send an `Authorization`
   * header yet; while off, any upgrade carrying an `Origin` header is refused,
   * because that would let a local web page drive an agent that runs commands.
   */
  acpRequireAuth: boolean
}

export const DEFAULT_APP_SERVER_CONFIG: AppServerConfig = {
  preferredPort: null,
  acpRequireAuth: true,
}

// -----------------------------------------------------------------------------
// Sandbox layer
// -----------------------------------------------------------------------------

/**
 * Agent operation mode.
 *
 * - `normal`: full read/write capability as defined by the approval policy and
 *   sandbox level. Default.
 * - `plan`: read-only mode. All write-class tools (workspace-write,
 *   terminal-command, browser-control, MCP calls) are denied before execution
 *   with a message that nudges the model to use `create_execution_plan`. The
 *   user must explicitly switch back to `normal` to execute writes. Mirrors
 *   Codex's `--approval-mode=plan`.
 * - `auto`: reserved for future Codex `full-auto` parity; currently behaves as
 *   `normal`. The field exists so the Settings UI can already show the option
 *   without a schema change later.
 */
export type AgentMode = 'normal' | 'plan' | 'auto'

/**
 * OS-level sandbox strength. The level is orthogonal to {@link ToolApprovalPolicy}
 * (which controls user prompts), but the two compose: a user-allowed `always-allow`
 * approval cannot downgrade a non-`off` sandbox.
 *
 * - `off`: no OS-level isolation. Approval prompts are the only fence. (Default;
 *   matches today's behavior; opt-in to avoid surprise regressions.)
 * - `permissive`: sandbox present and active, but allows most file / shell
 *   operations within the workspace and user-granted paths. Equivalent to
 *   Codex's `workspace_write` profile.
 * - `strict`: default-deny outside the workspace + Eva cache + scratch dir.
 *   Network calls are dropped. Mirrors Codex's `danger-full-access` profile's
 *   inverse.
 */
export type SandboxLevel = 'off' | 'permissive' | 'strict'

/**
 * Per-backend implementation availability. The Darwin and Linux backends depend
 * on system binaries (`sandbox-exec`, `bubblewrap`); if they're not on PATH the
 * effective level silently degrades to `permissive` and `lastError` is set.
 * The Windows backend is implemented in JS (path + command validation) and is
 * always available; native Win32 isolation is a documented follow-up.
 */
export interface SandboxBackendStatus {
  /** Which backend was selected at startup (e.g. `darwin-sandbox-exec`). */
  backend: string
  /** Whether the backend can actually enforce its level right now. */
  available: boolean
  /** Human-readable reason when `available === false`. */
  lastError: string | null
  /** Platform the backend targets. */
  platform: NodeJS.Platform
  /** True if the running process already passed the level check (for tests). */
  probedAt: number | null
}

export interface SandboxConfig {
  level: SandboxLevel
  /** Allow the sandboxed process to reach the network. Defaults to `false` for `strict`. */
  allowNetwork: boolean
  /**
   * Extra filesystem paths beyond the workspace that the sandbox is allowed to
   * read or write. These are granted in addition to `fileAccessGrants`.
   */
  extraAllowedPaths: string[]
  /**
   * Extra shell command patterns (anchored regex) that bypass the per-tool
   * command allow-list. Use sparingly — these bypass path validation too.
   */
  extraCommandPatterns: string[]
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  level: 'off',
  allowNetwork: true,
  extraAllowedPaths: [],
  extraCommandPatterns: [],
}

export interface AutomationConfig {
  team: HiddenCapabilityConfig
  task: HiddenCapabilityConfig
  goal: HiddenCapabilityConfig & { maxSteps: number; timeoutMinutes: number }
  plan: HiddenCapabilityConfig
  spec: HiddenCapabilityConfig
  toolApproval: ToolApprovalConfig
  /** OS-level sandbox that wraps terminal and file-write operations. */
  sandbox: SandboxConfig
  /** Agent operation mode. `plan` makes all writes read-only until the user
   *  switches back to `normal`; `auto` is a future Codex `full-auto` parity. */
  mode: AgentMode
}

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  team: { enabled: true, autoInvoke: true },
  task: { enabled: true, autoInvoke: true },
  goal: { enabled: true, autoInvoke: true, maxSteps: 12, timeoutMinutes: 30 },
  plan: { enabled: true, autoInvoke: true },
  spec: { enabled: true, autoInvoke: false },
  toolApproval: { policy: 'safe', timeoutMs: 60_000 },
  sandbox: DEFAULT_SANDBOX_CONFIG,
  mode: 'normal',
}
