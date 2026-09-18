//! Darwin (`sandbox-exec`) backend.
//!
//! `sandbox-exec` ships with every macOS install and lives at `/usr/bin`.
//! We probe it by running `sandbox-exec -h`; if the kernel extension is
//! loaded it returns 0, otherwise a non-zero exit code.
//!
//! ## Async vs sync
//!
//! The probe runs **once at startup** plus once when the user flips the
//! sandbox level.  Blocking the caller for ~50 ms (binary exec) is acceptable
//! for such a rare call, so we use `std::process::Command` directly and let
//! napi-rs's worker-thread executor handle the async wrapping at the FFI
//! boundary.  This avoids pulling a tokio runtime into the FFI layer.

use crate::types::{ProbeResult, SandboxContext, WrappedCommand};
use crate::profile::build_darwin_sandbox_exec_profile;

/// Probe the `sandbox-exec` availability (synchronous).
///
/// Returns `available: true` if `sandbox-exec -h` exits with code 0 or null
/// (both indicate the kernel extension is functional).
/// Returns `available: false` with `last_error` if the binary is missing or
/// the sandbox kernel extension is not loaded.
pub fn probe() -> ProbeResult {
    // Fast path: if we're not on Darwin, immediately reject.
    if !cfg!(target_os = "macos") {
        return ProbeResult {
            available: false,
            error: Some("not running on macOS".into()),
        };
    }

    match std::process::Command::new("sandbox-exec")
        .arg("-h")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .status()
    {
        Ok(status) => {
            let code = status.code();
            if status.success() || code.is_none() {
                ProbeResult {
                    available: true,
                    error: None,
                }
            } else {
                ProbeResult {
                    available: false,
                    error: Some(format!(
                        "sandbox-exec exited with code {}",
                        code.unwrap_or(-1)
                    )),
                }
            }
        }
        Err(e) => ProbeResult {
            available: false,
            error: Some(format!("failed to spawn sandbox-exec: {}", e)),
        },
    }
}

/// Build a `WrappedCommand` for macOS `sandbox-exec`.
///
/// The resulting argv is:
///   `['sandbox-exec', '-p', '<profile-text>', '<command>', ...<args>]`
pub fn wrap(
    command: &str,
    args: &[String],
    context: &SandboxContext,
) -> WrappedCommand {
    let profile = build_darwin_sandbox_exec_profile(&crate::types::ProfileInputs {
        workspace_path: context.workspace_path.clone(),
        extra_allowed_paths: context.extra_allowed_paths.clone(),
        allow_network: context.allow_network,
    });
    let mut all_args = vec!["-p".into(), profile.clone()];
    all_args.push(command.into());
    all_args.extend_from_slice(args);

    WrappedCommand {
        command: "sandbox-exec".into(),
        args: all_args,
        env_overrides: std::collections::HashMap::new(),
        profile: Some(profile),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn probe_rejects_non_macos() {
        let result = probe();
        assert!(!result.available);
        assert!(result.error.is_some());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn probe_returns_something_on_macos() {
        // On macOS we just verify the probe doesn't panic and returns a
        // valid ProbeResult.  Actual availability depends on kernel state.
        let result = probe();
        // Should never be the "not running on macOS" error since cfg!(macos).
        assert!(!result.error.as_ref().is_some_and(|e| e.contains("not running on macOS")));
    }
}
