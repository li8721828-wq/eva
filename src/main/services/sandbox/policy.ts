import type { AgentMode, SandboxConfig, SandboxLevel, ToolApprovalPolicy } from '../../../shared/types/automation'

/**
 * The sandbox layer is independent from the approval prompt layer, but they
 * compose. The composition rules are:
 *
 * - `sandbox.level === 'off'` does NOT bypass approvals; the user's prompt
 *   decision remains the source of truth.
 * - A non-`off` sandbox ALWAYS enforces its restrictions, even if the approval
 *   policy says `always-allow`. This is the point: approval is about "should
 *   Eva attempt this"; sandbox is about "what the OS allows".
 * - When `sandbox.level === 'strict'`, the approval policy is implicitly
 *   upgraded to `safe` even if the user picked `off`, so the user is still
 *   informed of destructive operations before they are attempted.
 *
 * Mode composition (`plan`):
 * - `plan` mode forces `sandbox.level` to at least `strict` regardless of the
 *   user's saved setting. Reads still work, but every write attempt must be
 *   approved (or, more commonly, the agent must produce a plan first).
 * - `plan` mode also upgrades the approval policy to at least `safe` so the
 *   user is always shown what the agent intends to do.
 *
 * The composition is intentionally simple (no per-tool overrides yet). Per-tool
 * granularity can be layered later without changing this function's shape.
 */
export interface ResolvedSandboxPolicy {
  /** Effective approval policy after sandbox composition. */
  effectiveApprovalPolicy: ToolApprovalPolicy
  /** Effective sandbox level after composition. */
  effectiveSandboxLevel: SandboxLevel
  /** Whether the OS sandbox is active (not `off`). */
  sandboxActive: boolean
  /** Effective agent mode after composition. `plan` is sticky until the user
   *  switches back. `auto` is currently treated as `normal`. */
  effectiveMode: Exclude<AgentMode, 'auto'>
  /** Human-readable explanation of the composition, for the approval card. */
  note: string | null
}

export function resolveSandboxPolicy(
  approvalPolicy: ToolApprovalPolicy,
  sandbox: SandboxConfig,
  mode: AgentMode = 'normal',
): ResolvedSandboxPolicy {
  const effectiveMode: Exclude<AgentMode, 'auto'> = mode === 'auto' ? 'normal' : mode

  // Plan mode forces the sandbox to strict even if the user saved `off`.
  let effectiveLevel: SandboxLevel = sandbox.level
  if (effectiveMode === 'plan' && (effectiveLevel === 'off' || effectiveLevel === 'permissive')) {
    effectiveLevel = 'strict'
  }

  if (effectiveLevel === 'off') {
    return {
      effectiveApprovalPolicy: approvalPolicy,
      effectiveSandboxLevel: 'off',
      sandboxActive: false,
      effectiveMode,
      note: null,
    }
  }

  // Non-off sandbox: enforce approvals as `safe` at minimum so the user knows
  // when destructive operations are about to be sandboxed.
  let effectiveApprovalPolicy: ToolApprovalPolicy =
    approvalPolicy === 'off' ? 'safe' : approvalPolicy

  // Plan mode always requires explicit approval for any write attempt, even
  // if the user picked `paranoid` (which is fine) — keep paranoid if chosen.
  // (No downgrade needed; the plan mode itself gates execution.)

  const notes: string[] = []
  if (effectiveMode === 'plan' && sandbox.level !== 'strict') {
    notes.push(`Plan mode 已临时升级沙箱为 strict（用户设置：${sandbox.level}）。`)
  }
  // The two guards below used to also check `effectiveLevel !== 'off'`, but
  // at this point `effectiveLevel` is already narrowed to `'strict' |
  // 'permissive'` (the `'off'` case returned above).  The comparisons were
  // dead branches and tripped `tsc`'s TS2367.  Keep the logic clear without
  // the redundant check.
  if (approvalPolicy === 'off') {
    notes.push('审批策略已临时升级为 safe，因为沙箱已开启。')
  }
  if (approvalPolicy !== 'off') {
    notes.push(`沙箱（${effectiveLevel}）将在审批通过后强制执行操作系统级限制。`)
  }

  return {
    effectiveApprovalPolicy,
    effectiveSandboxLevel: effectiveLevel,
    sandboxActive: true,
    effectiveMode,
    note: notes.length > 0 ? notes.join(' ') : null,
  }
}
