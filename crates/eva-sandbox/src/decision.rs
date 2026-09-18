//! Pure policy-enforcement functions shared by all backends.
//!
//! These are pure predicates — no I/O, no syscalls, no side effects.
//! Mirrors the `pathDecision` and `defaultCommandDecision` functions
//! exported from `src/main/services/sandbox/backends/darwin.ts`.

use crate::types::{FsOperation, SandboxContext, SandboxDecision, SandboxLevel};

/// Platform identifier used when constructing `SandboxDecision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxBackendName {
    Noop,
    DarwinSandboxExec,
    LinuxBubblewrap,
    Win32PolicyOnly,
}

impl SandboxBackendName {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Noop => "noop",
            Self::DarwinSandboxExec => "darwin-sandbox-exec",
            Self::LinuxBubblewrap => "linux-bubblewrap",
            Self::Win32PolicyOnly => "win32-policy-only",
        }
    }
}

// ---------------------------------------------------------------------------
// Path decision
// ---------------------------------------------------------------------------

/// Evaluate a filesystem path against the sandbox policy.
///
/// Mirrors `pathDecision` in backends/darwin.ts.
/// Returns the standard "allowed inside allowed set / denied otherwise" answer.
pub fn path_decision(
    target_path: &str,
    operation: FsOperation,
    context: &SandboxContext,
    backend: SandboxBackendName,
) -> SandboxDecision {
    if context.level == SandboxLevel::Off {
        return SandboxDecision {
            allowed: true,
            reason: "sandbox is off".into(),
            backend: backend.as_str().into(),
        };
    }

    let normalized = target_path.replace('\\', "/").to_lowercase();
    let allowed_roots: Vec<String> = context
        .extra_allowed_paths
        .iter()
        .chain(std::iter::once(&context.workspace_path))
        .filter(|root| !root.is_empty())
        .map(|root| root.replace('\\', "/").to_lowercase())
        .collect();

    for root in &allowed_roots {
        if normalized == *root || normalized.starts_with(&format!("{}/", root)) {
            return SandboxDecision {
                allowed: true,
                reason: format!("path is within {}", root),
                backend: backend.as_str().into(),
            };
        }
    }

    // Read operations also allow the read-only system roots.
    if operation == FsOperation::Read {
        for &root in read_only_roots() {
            if normalized.starts_with(root) {
                return SandboxDecision {
                    allowed: true,
                    reason: format!("read-only system path: {}", root),
                    backend: backend.as_str().into(),
                };
            }
        }
    }

    SandboxDecision {
        allowed: false,
        reason: if operation == FsOperation::Write {
            format!("写入路径 {} 不在沙箱允许列表内。", target_path)
        } else {
            format!("读取路径 {} 不在沙箱允许列表内。", target_path)
        },
        backend: backend.as_str().into(),
    }
}

/// Read-only system path prefixes (all end with `/` to avoid prefix collision).
fn read_only_roots() -> &'static [&'static str] {
    // Platform detection via compile-time cfg for clarity; the caller passes
    // the right context so this is just the fallback.
    if cfg!(target_os = "macos") {
        &DARWIN_READONLY_ROOTS
    } else if cfg!(target_os = "linux") {
        &LINUX_READONLY_ROOTS
    } else {
        &WINDOWS_READONLY_ROOTS
    }
}

const DARWIN_READONLY_ROOTS: &[&str] = &[
    "/usr/",
    "/bin/",
    "/sbin/",
    "/library/",
    "/system/",
    "/private/etc/",
    "/private/var/",
    "/etc/",
    "/var/",
    "/tmp/",
    "/dev/",
];

const LINUX_READONLY_ROOTS: &[&str] = &[
    "/usr/",
    "/bin/",
    "/sbin/",
    "/lib/",
    "/etc/",
    "/var/",
    "/opt/",
    "/tmp/",
    "/run/",
    "/sys/",
    "/proc/",
    "/dev/",
];

const WINDOWS_READONLY_ROOTS: &[&str] = &[
    "c:/windows/",
    "c:/program files/",
    "c:/program files (x86)/",
    "c:/windows/system32/",
];

// ---------------------------------------------------------------------------
// Command decision
// ---------------------------------------------------------------------------

/// Evaluate a shell command line against the sandbox policy.
///
/// Mirrors `defaultCommandDecision` in backends/darwin.ts.
/// The OS sandbox is the real enforcer; this only blocks obviously catastrophic
/// patterns as a fast pre-check.  Used on Windows where no OS sandbox exists
/// and as defense-in-depth on every other platform.
pub fn default_command_decision(
    command_line: &str,
    context: &SandboxContext,
    backend: SandboxBackendName,
) -> SandboxDecision {
    if context.level == SandboxLevel::Off {
        return SandboxDecision {
            allowed: true,
            reason: "sandbox is off".into(),
            backend: backend.as_str().into(),
        };
    }

    let lower = command_line.to_lowercase();

    for pattern in DANGEROUS_PATTERNS.iter() {
        if pattern.is_match(&lower) {
            return SandboxDecision {
                allowed: false,
                reason: format!(
                    "拒绝执行危险命令：{}",
                    &command_line[..command_line.len().min(80)]
                ),
                backend: backend.as_str().into(),
            };
        }
    }

    SandboxDecision {
        allowed: true,
        reason: "command passed sandbox check".into(),
        backend: backend.as_str().into(),
    }
}

/// Compiled dangerous-command regex patterns.
/// Mirrors the `dangerous` array in backends/darwin.ts.
fn compile_dangerous_patterns() -> Vec<regex::Regex> {
    [
        // Unix: rm -rf /
        r"rm\s+-rf?\s+/(?:\s|$)",
        // Unix: rm -rf \\
        r"rm\s+-rf?\s+\\(?:\s|$)",
        // Windows: format
        r"format\s+[a-z]:",
        // Windows: bcdedit
        r"bcdedit",
        // Windows: reg delete
        r"reg\s+delete\s+hkey_(local_machine|current_user|users|classes_root)",
        // Windows: diskpart
        r"diskpart",
        // Windows PowerShell: Remove-Item with both -Recurse and -Force
        // flags targeting C:\.  PowerShell flag order is not fixed, so we
        // cover the three common orderings explicitly.  Case-insensitive.
        r"(?i)remove-item\s+.*-recurse.*-force.*c:\\",
        r"(?i)remove-item\s+.*-force.*-recurse.*c:\\",
        r"(?i)remove-item\s+.*c:\\.*-recurse.*-force",
        // Windows cmd: del /s /q C:\
        r"del\s+/s\s+/q\s+c:\\",
        // Windows: shutdown
        r"shutdown\s+/s",
    ]
    .iter()
    .map(|s| regex::Regex::new(s).expect("dangerous pattern must be valid regex"))
    .collect()
}

lazy_static::lazy_static! {
    static ref DANGEROUS_PATTERNS: Vec<regex::Regex> = compile_dangerous_patterns();
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SandboxContext;

    fn ctx(level: SandboxLevel, workspace: &str) -> SandboxContext {
        SandboxContext {
            workspace_path: workspace.into(),
            file_access_grants: vec![],
            extra_allowed_paths: vec![],
            allow_network: true,
            level,
        }
    }

    // ── off level always allows ────────────────────────────────────────────

    #[test]
    fn path_decision_off_allows_all() {
        for op in [FsOperation::Read, FsOperation::Write] {
            let result = path_decision("/any/path", op, &ctx(SandboxLevel::Off, "/w"), SandboxBackendName::DarwinSandboxExec);
            assert!(result.allowed, "off level must allow all paths");
            assert_eq!(result.reason, "sandbox is off");
        }
    }

    #[test]
    fn command_decision_off_allows_all() {
        let result = default_command_decision(
            "rm -rf /",
            &ctx(SandboxLevel::Off, "/w"),
            SandboxBackendName::Win32PolicyOnly,
        );
        assert!(result.allowed);
        assert_eq!(result.reason, "sandbox is off");
    }

    // ── path decision workspace ─────────────────────────────────────────────

    #[test]
    fn path_workspace_allowed() {
        let result = path_decision(
            "/workspace/src/main.ts",
            FsOperation::Read,
            &ctx(SandboxLevel::Strict, "/workspace"),
            SandboxBackendName::DarwinSandboxExec,
        );
        assert!(result.allowed, "workspace subpath must be allowed: {:?}", result.reason);
    }

    #[test]
    fn path_workspace_write_allowed() {
        let result = path_decision(
            "/workspace/src/main.ts",
            FsOperation::Write,
            &ctx(SandboxLevel::Strict, "/workspace"),
            SandboxBackendName::DarwinSandboxExec,
        );
        assert!(result.allowed, "workspace write must be allowed: {:?}", result.reason);
    }

    #[test]
    fn path_outside_workspace_denied() {
        let result = path_decision(
            "/etc/passwd",
            FsOperation::Write,
            &ctx(SandboxLevel::Strict, "/workspace"),
            SandboxBackendName::LinuxBubblewrap,
        );
        assert!(!result.allowed, "writes outside workspace must be denied");
    }

    #[test]
    fn path_extra_allowed_paths_allowed() {
        let mut ctx = ctx(SandboxLevel::Strict, "/workspace");
        ctx.extra_allowed_paths.push("/shared".into());
        let result = path_decision(
            "/shared/data.json",
            FsOperation::Write,
            &ctx,
            SandboxBackendName::DarwinSandboxExec,
        );
        assert!(result.allowed, "extraAllowedPaths write must be allowed: {:?}", result.reason);
    }

    #[test]
    fn path_windows_normalized() {
        let result = path_decision(
            r"C:\Windows\System32\config\sam",
            FsOperation::Write,
            &ctx(SandboxLevel::Strict, r"D:\workspace"),
            SandboxBackendName::Win32PolicyOnly,
        );
        assert!(!result.allowed, "Windows system write must be denied: {:?}", result.reason);
    }

    #[test]
    fn path_read_system_allowed() {
        let result = path_decision(
            "/usr/bin/bash",
            FsOperation::Read,
            &ctx(SandboxLevel::Strict, "/workspace"),
            SandboxBackendName::DarwinSandboxExec,
        );
        // cfg!(target_os) is compile-time; this test is cross-platform.
        // On Darwin it should allow (read-only root); on Linux also allow;
        // on Windows it will deny (no /usr/ in WINDOWS_READONLY_ROOTS).
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert!(result.allowed, "system read must be allowed: {:?}", result.reason);
        #[cfg(target_os = "windows")]
        assert!(
            !result.allowed || result.reason.contains("read-only"),
            "on Windows /usr/ is not a read-only root: {:?}",
            result.reason
        );
    }

    #[test]
    fn path_read_dev_denied_write() {
        let result = path_decision(
            "/dev/null",
            FsOperation::Write,
            &ctx(SandboxLevel::Strict, "/workspace"),
            SandboxBackendName::DarwinSandboxExec,
        );
        // /dev is in read-only roots, so /dev/null write is denied.
        assert!(!result.allowed);
    }

    // ── command decision ─────────────────────────────────────────────────

    #[test]
    fn command_rm_rf_denied() {
        let result = default_command_decision(
            "rm -rf /",
            &ctx(SandboxLevel::Strict, "/w"),
            SandboxBackendName::DarwinSandboxExec,
        );
        assert!(!result.allowed);
        assert!(result.reason.contains("拒绝执行危险命令"));
    }

    #[test]
    fn command_rm_rf_windows_backslash_denied() {
        let result = default_command_decision(
            "rm -rf \\",
            &ctx(SandboxLevel::Strict, "/w"),
            SandboxBackendName::DarwinSandboxExec,
        );
        assert!(!result.allowed);
    }

    #[test]
    fn command_format_denied() {
        let result = default_command_decision(
            "format D:",
            &ctx(SandboxLevel::Strict, "/w"),
            SandboxBackendName::Win32PolicyOnly,
        );
        assert!(!result.allowed);
    }

    #[test]
    fn command_bcdedit_denied() {
        let result = default_command_decision(
            "bcdedit",
            &ctx(SandboxLevel::Strict, "/w"),
            SandboxBackendName::Win32PolicyOnly,
        );
        assert!(!result.allowed);
    }

    #[test]
    fn command_shutdown_denied() {
        let result = default_command_decision(
            "shutdown /s /t 0",
            &ctx(SandboxLevel::Strict, "/w"),
            SandboxBackendName::Win32PolicyOnly,
        );
        assert!(!result.allowed);
    }

    #[test]
    fn command_echo_allowed() {
        let result = default_command_decision(
            "echo hello world",
            &ctx(SandboxLevel::Strict, "/w"),
            SandboxBackendName::DarwinSandboxExec,
        );
        assert!(result.allowed);
        assert_eq!(result.reason, "command passed sandbox check");
    }

    #[test]
    fn command_npm_install_allowed() {
        let result = default_command_decision(
            "npm install",
            &ctx(SandboxLevel::Strict, "/w"),
            SandboxBackendName::DarwinSandboxExec,
        );
        assert!(result.allowed);
    }

    #[test]
    fn command_remove_item_powershell_denied() {
        let result = default_command_decision(
            "Remove-Item -Path C:\\Windows -Recurse -Force",
            &ctx(SandboxLevel::Strict, "/w"),
            SandboxBackendName::Win32PolicyOnly,
        );
        assert!(!result.allowed);
    }
}
