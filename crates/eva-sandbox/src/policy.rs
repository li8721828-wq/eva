//! Policy composition: merges `ToolApprovalPolicy` + `SandboxConfig` + `AgentMode`
//! into an effective `ResolvedSandboxPolicy`.
//!
//! This is a pure function — no I/O, no syscalls, no side effects.
//! Mirrors `src/main/services/sandbox/policy.ts` exactly.

use crate::types::{
    AgentMode, ResolvedSandboxPolicy, SandboxConfig, SandboxLevel, ToolApprovalPolicy,
};

/// Resolve the effective sandbox policy given user settings and agent mode.
///
/// Composition rules (mirrors the TypeScript comments in policy.ts):
///
/// 1. `sandbox.level === 'off'` → `sandboxActive: false`, approval unchanged.
/// 2. Non-`off` sandbox + `approvalPolicy === 'off'` → `effectiveApprovalPolicy`
///    is upgraded to `'safe'` so the user still sees destructive operations.
/// 3. `mode === 'plan'` + `level` is `'off'` or `'permissive'`
///    → `effectiveLevel` is upgraded to `'strict'`.
/// 4. `mode === 'auto'` is always treated as `'normal'`.
#[must_use]
pub fn resolve_sandbox_policy(
    approval_policy: ToolApprovalPolicy,
    sandbox: &SandboxConfig,
    mode: AgentMode,
) -> ResolvedSandboxPolicy {
    let effective_mode = match mode {
        AgentMode::Auto => AgentMode::Normal,
        other => other,
    };

    // Plan mode forces the sandbox to strict even if the user saved `off`.
    let mut effective_level = sandbox.level;
    if effective_mode == AgentMode::Plan {
        if effective_level == SandboxLevel::Off || effective_level == SandboxLevel::Permissive {
            effective_level = SandboxLevel::Strict;
        }
    }

    if effective_level == SandboxLevel::Off {
        return ResolvedSandboxPolicy {
            effective_approval_policy: approval_policy,
            effective_sandbox_level: SandboxLevel::Off,
            sandbox_active: false,
            effective_mode,
            note: None,
        };
    }

    // Non-off sandbox: enforce approvals as `safe` at minimum so the user knows
    // when destructive operations are about to be sandboxed.
    let effective_approval_policy = match approval_policy {
        ToolApprovalPolicy::Off => ToolApprovalPolicy::Safe,
        other => other,
    };

    let mut notes: Vec<String> = Vec::new();

    if effective_mode == AgentMode::Plan && sandbox.level != SandboxLevel::Strict {
        notes.push(format!(
            "Plan mode 已临时升级沙箱为 strict（用户设置：{}）。",
            level_to_chinese(&sandbox.level)
        ));
    }
    if approval_policy == ToolApprovalPolicy::Off && effective_level != SandboxLevel::Off {
        notes.push("审批策略已临时升级为 safe，因为沙箱已开启。".into());
    }
    if effective_level != SandboxLevel::Off && approval_policy != ToolApprovalPolicy::Off {
        notes.push(format!(
            "沙箱（{}）将在审批通过后强制执行操作系统级限制。",
            level_to_chinese(&effective_level)
        ));
    }

    ResolvedSandboxPolicy {
        effective_approval_policy,
        effective_sandbox_level: effective_level,
        sandbox_active: true,
        effective_mode,
        note: if notes.is_empty() {
            None
        } else {
            Some(notes.join(" "))
        },
    }
}

fn level_to_chinese(level: &SandboxLevel) -> &'static str {
    match level {
        SandboxLevel::Off => "off",
        SandboxLevel::Permissive => "permissive",
        SandboxLevel::Strict => "strict",
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SandboxConfig;

    fn config(level: SandboxLevel) -> SandboxConfig {
        SandboxConfig {
            level,
            allow_network: true,
            extra_allowed_paths: vec![],
            extra_command_patterns: vec![],
        }
    }

    // ── off: sandbox inactive ──────────────────────────────────────────────

    #[test]
    fn off_level_sandbox_inactive() {
        for policy in [
            ToolApprovalPolicy::Off,
            ToolApprovalPolicy::Safe,
            ToolApprovalPolicy::Strict,
            ToolApprovalPolicy::Paranoid,
        ] {
            let result = resolve_sandbox_policy(policy, &config(SandboxLevel::Off), AgentMode::Normal);
            assert!(!result.sandbox_active, "sandboxActive must be false when level is off");
            assert_eq!(result.effective_sandbox_level, SandboxLevel::Off);
            assert_eq!(result.effective_approval_policy, policy, "approvalPolicy must be preserved");
            assert_eq!(result.effective_mode, AgentMode::Normal);
            assert!(result.note.is_none());
        }
    }

    #[test]
    fn off_level_note_is_null() {
        let result = resolve_sandbox_policy(
            ToolApprovalPolicy::Off,
            &config(SandboxLevel::Off),
            AgentMode::Normal,
        );
        assert!(result.note.is_none());
    }

    // ── permissive: off approval upgrades to safe ───────────────────────────

    #[test]
    fn permissive_off_approval_upgrades_to_safe() {
        let result = resolve_sandbox_policy(
            ToolApprovalPolicy::Off,
            &config(SandboxLevel::Permissive),
            AgentMode::Normal,
        );
        assert!(result.sandbox_active);
        assert_eq!(result.effective_sandbox_level, SandboxLevel::Permissive);
        assert_eq!(result.effective_approval_policy, ToolApprovalPolicy::Safe);
        assert!(result.note.is_some());
    }

    #[test]
    fn permissive_preserves_existing_approval() {
        for policy in [ToolApprovalPolicy::Safe, ToolApprovalPolicy::Strict, ToolApprovalPolicy::Paranoid] {
            let result = resolve_sandbox_policy(
                policy,
                &config(SandboxLevel::Permissive),
                AgentMode::Normal,
            );
            assert_eq!(result.effective_approval_policy, policy);
            assert!(result.sandbox_active);
        }
    }

    // ── strict: off approval upgrades to safe ──────────────────────────────

    #[test]
    fn strict_off_approval_upgrades_to_safe() {
        let result = resolve_sandbox_policy(
            ToolApprovalPolicy::Off,
            &config(SandboxLevel::Strict),
            AgentMode::Normal,
        );
        assert!(result.sandbox_active);
        assert_eq!(result.effective_sandbox_level, SandboxLevel::Strict);
        assert_eq!(result.effective_approval_policy, ToolApprovalPolicy::Safe);
        assert!(result.note.is_some());
    }

    // ── plan mode upgrades level ────────────────────────────────────────────

    #[test]
    fn plan_mode_upgrades_off_to_strict() {
        let result = resolve_sandbox_policy(
            ToolApprovalPolicy::Off,
            &config(SandboxLevel::Off),
            AgentMode::Plan,
        );
        assert!(result.sandbox_active);
        assert_eq!(result.effective_sandbox_level, SandboxLevel::Strict);
        assert_eq!(result.effective_approval_policy, ToolApprovalPolicy::Safe);
        assert_eq!(result.effective_mode, AgentMode::Plan);
    }

    #[test]
    fn plan_mode_upgrades_permissive_to_strict() {
        let result = resolve_sandbox_policy(
            ToolApprovalPolicy::Safe,
            &config(SandboxLevel::Permissive),
            AgentMode::Plan,
        );
        assert_eq!(result.effective_sandbox_level, SandboxLevel::Strict);
        assert_eq!(result.effective_mode, AgentMode::Plan);
    }

    // ── auto treated as normal ─────────────────────────────────────────────

    #[test]
    fn auto_mode_treated_as_normal() {
        let result = resolve_sandbox_policy(
            ToolApprovalPolicy::Safe,
            &config(SandboxLevel::Strict),
            AgentMode::Auto,
        );
        assert_eq!(result.effective_mode, AgentMode::Normal);
    }

    // ── note present when sandbox on ────────────────────────────────────────

    #[test]
    fn note_present_when_sandbox_on_and_upgraded() {
        let result = resolve_sandbox_policy(
            ToolApprovalPolicy::Off,
            &config(SandboxLevel::Strict),
            AgentMode::Normal,
        );
        assert!(result.note.is_some());
        let note = result.note.unwrap();
        assert!(note.contains("审批策略已临时升级为 safe"));
    }

    #[test]
    fn note_present_when_sandbox_on_and_not_upgraded() {
        let result = resolve_sandbox_policy(
            ToolApprovalPolicy::Safe,
            &config(SandboxLevel::Strict),
            AgentMode::Normal,
        );
        assert!(result.note.is_some());
    }
}
