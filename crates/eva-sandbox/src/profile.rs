//! OS-specific sandbox profile generators.
//!
//! These are pure functions — no I/O, no side effects.  They take
//! `ProfileInputs` and return the profile text / argv array that gets
//! passed to the OS sandboxing binary.
//!
//! Mirrors `src/main/services/sandbox/profile-builder.ts`.

use crate::types::ProfileInputs;

// ---------------------------------------------------------------------------
// Darwin: sandbox-exec profile
// ---------------------------------------------------------------------------

/// Build the macOS `sandbox-exec` S-expression profile.
/// Denies all by default, then opens specific read / write paths.
pub fn build_darwin_sandbox_exec_profile(inputs: &ProfileInputs) -> String {
    let mut lines: Vec<String> = vec!["(version 1)".into(), "(deny default)".into()];

    // System paths: read-only.
    for &path in DARWIN_READONLY_SYSTEM_PATHS {
        lines.push(format!(
            "(allow file-read* (subpath \"{}\"))",
            escape_sexp(path)
        ));
    }

    // Network: optional.
    if inputs.allow_network {
        lines.push("(allow network*)".into());
    }

    // Workspace + extra grants: read + write.
    if !inputs.workspace_path.is_empty() {
        lines.push(format!(
            "(allow file-read* file-write* (subpath \"{}\"))",
            escape_sexp(&inputs.workspace_path)
        ));
    }
    for extra in &inputs.extra_allowed_paths {
        lines.push(format!(
            "(allow file-read* file-write* (subpath \"{}\"))",
            escape_sexp(extra)
        ));
    }

    // Eva's own cache directory.
    lines.push("(allow file-read* file-write* (subpath \"${HOME}/Library/Caches/com.eva.agent\"))".into());

    lines.join("\n") + "\n"
}

/// Darwin system paths that are always readable inside the sandbox.
const DARWIN_READONLY_SYSTEM_PATHS: &[&str] = &[
    "/usr/lib",
    "/usr/libexec",
    "/usr/share",
    "/usr/bin",
    "/bin",
    "/sbin",
    "/System/Library",
    "/Library/Apple",
    "/Library/Frameworks",
    "/private/etc",
    "/private/var",
    "/etc",
    "/var",
    "/tmp",
    "/dev",
];

// ---------------------------------------------------------------------------
// Linux: bubblewrap argv
// ---------------------------------------------------------------------------

/// Build the Linux `bwrap` (bubblewrap) argv array.
/// We use `--ro-bind` for system paths and `--bind` for the workspace
/// so writes inside the workspace work but reads outside it see a read-only view.
pub fn build_bubblewrap_args(inputs: &ProfileInputs) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--unshare-user-try".into(),
        "--unshare-pid-try".into(),
        "--unshare-ipc".into(),
        "--unshare-uts".into(),
        "--die-with-parent".into(),
        "--proc".into(), "/proc".into(),
        "--dev".into(), "/dev".into(),
        "--tmpfs".into(), "/tmp".into(),
    ];

    if !inputs.allow_network {
        args.push("--unshare-net".into());
    }

    // System paths: read-only.
    for &path in LINUX_READONLY_SYSTEM_PATHS {
        if !path.starts_with('/') {
            continue;
        }
        args.push("--ro-bind".into());
        args.push(path.into());
        args.push(path.into());
    }

    // Temp dirs: tmpfs (read-write scratch, isolated).
    args.push("--bind".into());
    args.push("/tmp".into());
    args.push("/tmp".into());

    // Workspace + extra grants: bind-writable.
    if !inputs.workspace_path.is_empty() {
        args.push("--bind".into());
        args.push(inputs.workspace_path.clone());
        args.push(inputs.workspace_path.clone());
    }
    for extra in &inputs.extra_allowed_paths {
        args.push("--bind".into());
        args.push(extra.clone());
        args.push(extra.clone());
    }

    // Eva cache directory.
    args.push("--ro-bind".into());
    args.push("${HOME}/.cache/eva".into());
    args.push("${HOME}/.cache/eva".into());

    args
}

/// Linux system paths that are always readable inside the sandbox.
const LINUX_READONLY_SYSTEM_PATHS: &[&str] = &[
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
    "/var",
    "/opt",
    "/tmp",
    "/run",
    "/sys",
    "/proc",
    "/dev",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Escape a string for embedding in a sandbox-exec S-expression.
///
/// Backslashes are doubled, then double-quotes are escaped.
/// This mirrors the `escapeSexp` function in profile-builder.ts.
fn escape_sexp(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Sanitize a path before it is embedded in a profile.
///
/// - Rejects NUL bytes.
/// - Returns empty string for empty input.
/// - Caller is responsible for passing a normalized absolute path;
///   this is a safety net only.
pub fn sanitize_profile_path(candidate: &str) -> Result<String, &'static str> {
    if candidate.is_empty() {
        return Ok(String::new());
    }
    if candidate.contains('\0') {
        return Err("Profile path contains NUL byte");
    }
    Ok(candidate.to_owned())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(workspace: &str) -> ProfileInputs {
        ProfileInputs {
            workspace_path: workspace.into(),
            extra_allowed_paths: vec![],
            allow_network: true,
        }
    }

    fn inputs_with_extras(workspace: &str, extras: Vec<String>) -> ProfileInputs {
        ProfileInputs {
            workspace_path: workspace.into(),
            extra_allowed_paths: extras,
            allow_network: true,
        }
    }

    // ── Darwin profile ──────────────────────────────────────────────────────

    #[test]
    fn darwin_profile_has_version_and_deny_default() {
        let profile = build_darwin_sandbox_exec_profile(&inputs("/foo/bar"));
        assert!(profile.starts_with("(version 1)\n(deny default)"));
    }

    #[test]
    fn darwin_profile_has_workspace() {
        let profile = build_darwin_sandbox_exec_profile(&inputs("/foo/bar"));
        assert!(profile.contains("(allow file-read* file-write* (subpath \"/foo/bar\"))"));
    }

    #[test]
    fn darwin_profile_has_extra_paths() {
        let profile = build_darwin_sandbox_exec_profile(&inputs_with_extras(
            "/workspace",
            vec!["/shared".into(), "/data".into()],
        ));
        assert!(profile.contains("(allow file-read* file-write* (subpath \"/shared\"))"));
        assert!(profile.contains("(allow file-read* file-write* (subpath \"/data\"))"));
    }

    #[test]
    fn darwin_profile_allows_network_when_enabled() {
        let profile = build_darwin_sandbox_exec_profile(&ProfileInputs {
            workspace_path: "/foo".into(),
            extra_allowed_paths: vec![],
            allow_network: true,
        });
        assert!(profile.contains("(allow network*)"));
    }

    #[test]
    fn darwin_profile_blocks_network_when_disabled() {
        let profile = build_darwin_sandbox_exec_profile(&ProfileInputs {
            workspace_path: "/foo".into(),
            extra_allowed_paths: vec![],
            allow_network: false,
        });
        assert!(!profile.contains("(allow network*)"));
    }

    #[test]
    fn darwin_profile_has_escape_in_path() {
        // A path with quotes and backslashes must be escaped.
        let profile = build_darwin_sandbox_exec_profile(&ProfileInputs {
            workspace_path: r#"C:\Users\"Jane"\Docs"#.into(),
            extra_allowed_paths: vec![],
            allow_network: false,
        });
        // The escaped version should NOT contain unescaped quotes.
        assert!(!profile.contains(r#"="Jane"#));
        assert!(profile.contains(r#"\\"#));
    }

    // ── Bubblewrap args ─────────────────────────────────────────────────────

    #[test]
    fn bwrap_args_has_unshare_flags() {
        let args = build_bubblewrap_args(&inputs("/workspace"));
        assert!(args.contains(&"--unshare-user-try".into()));
        assert!(args.contains(&"--unshare-pid-try".into()));
    }

    #[test]
    fn bwrap_args_has_network_control() {
        let with_network = build_bubblewrap_args(&ProfileInputs {
            workspace_path: "/foo".into(),
            extra_allowed_paths: vec![],
            allow_network: true,
        });
        let without_network = build_bubblewrap_args(&ProfileInputs {
            workspace_path: "/foo".into(),
            extra_allowed_paths: vec![],
            allow_network: false,
        });
        assert!(!with_network.contains(&"--unshare-net".into()));
        assert!(without_network.contains(&"--unshare-net".into()));
    }

    #[test]
    fn bwrap_args_has_extra_paths() {
        let args = build_bubblewrap_args(&inputs_with_extras(
            "/workspace",
            vec!["/shared".into()],
        ));
        let args_str = args.join(" ");
        assert!(args_str.contains("--bind /shared /shared"));
    }

    // ── sanitize_profile_path ──────────────────────────────────────────────

    #[test]
    fn sanitize_rejects_nul_byte() {
        assert!(sanitize_profile_path("foo\0bar").is_err());
    }

    #[test]
    fn sanitize_accepts_valid_path() {
        assert_eq!(sanitize_profile_path("/foo/bar").unwrap(), "/foo/bar");
    }

    #[test]
    fn sanitize_empty_returns_empty() {
        assert_eq!(sanitize_profile_path("").unwrap(), "");
    }
}
