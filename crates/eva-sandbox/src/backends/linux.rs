//! Linux (bubblewrap / `bwrap`) backend.
//!
//! `bwrap` is NOT shipped with most distros — it must be installed separately
//! and be on PATH.  We probe it by running `bwrap --version`.
//!
//! ## Async vs sync
//!
//! Like the Darwin backend, the probe runs once at startup.  We use
//! `std::process::Command` directly; napi-rs's worker-thread executor handles
//! the async wrapping at the FFI boundary.

use crate::types::{ProbeResult, SandboxContext, WrappedCommand};
use crate::profile::build_bubblewrap_args;

/// Probe the `bwrap` (bubblewrap) availability (synchronous).
///
/// Returns `available: true` if `bwrap --version` exits with code 0.
pub fn probe() -> ProbeResult {
    if !cfg!(target_os = "linux") {
        return ProbeResult {
            available: false,
            error: Some("not running on Linux".into()),
        };
    }

    match std::process::Command::new("bwrap")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .status()
    {
        Ok(status) => {
            if status.success() {
                ProbeResult {
                    available: true,
                    error: None,
                }
            } else {
                ProbeResult {
                    available: false,
                    error: Some(format!("bwrap exited with code {:?}", status.code())),
                }
            }
        }
        Err(e) => ProbeResult {
            available: false,
            error: Some(format!("failed to spawn bwrap: {}", e)),
        },
    }
}

/// Build a `WrappedCommand` for Linux `bwrap`.
///
/// The resulting argv is:
///   `['bwrap', <bwrap-args...>, '--', '<command>', ...<args>]`
pub fn wrap(
    command: &str,
    args: &[String],
    context: &SandboxContext,
) -> WrappedCommand {
    let profile_inputs = crate::types::ProfileInputs {
        workspace_path: context.workspace_path.clone(),
        extra_allowed_paths: context.extra_allowed_paths.clone(),
        allow_network: context.allow_network,
    };
    let bwrap_args = build_bubblewrap_args(&profile_inputs);
    let mut all_args = bwrap_args.clone();
    all_args.push("--".into());
    all_args.push(command.into());
    all_args.extend_from_slice(args);

    WrappedCommand {
        command: "bwrap".into(),
        args: all_args,
        env_overrides: std::collections::HashMap::new(),
        profile: Some(bwrap_args.join(" ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn probe_rejects_non_linux() {
        let result = probe();
        assert!(!result.available);
        assert!(result.error.is_some());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn probe_returns_something_on_linux() {
        let result = probe();
        assert!(!result.error.as_ref().is_some_and(|e| e.contains("not running on Linux")));
    }
}
