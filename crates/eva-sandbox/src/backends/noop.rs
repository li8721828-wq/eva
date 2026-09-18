//! Noop backend.
//!
//! Used when the user has explicitly set `sandbox.level === 'off'` or when
//! the platform-specific backend failed its `probe()`.

use crate::types::{FsOperation, SandboxContext, SandboxDecision, WrappedCommand};

/// Always available; returns argv unchanged and allows all decisions.
pub fn probe() -> crate::types::ProbeResult {
    crate::types::ProbeResult {
        available: true,
        error: None,
    }
}

/// Return the original argv unchanged (no native wrap on noop).
pub fn wrap(
    command: &str,
    args: &[String],
    _context: &SandboxContext,
) -> WrappedCommand {
    WrappedCommand {
        command: command.into(),
        args: args.to_vec(),
        env_overrides: std::collections::HashMap::new(),
        profile: None,
    }
}

/// Always allows, reason = "sandbox is off".
pub fn evaluate_command(
    _command_line: &str,
    _context: &SandboxContext,
) -> SandboxDecision {
    SandboxDecision {
        allowed: true,
        reason: "sandbox is off".into(),
        backend: "noop".into(),
    }
}

/// Always allows, reason = "sandbox is off".
pub fn evaluate_path(
    _target_path: &str,
    _operation: FsOperation,
    _context: &SandboxContext,
) -> SandboxDecision {
    SandboxDecision {
        allowed: true,
        reason: "sandbox is off".into(),
        backend: "noop".into(),
    }
}
