//! Core domain types for the sandbox subsystem.
//!
//! These structs mirror the TypeScript interfaces in
//! `src/main/services/sandbox/types.ts` and the shared types in
//! `src/shared/types/automation.ts` and `src/shared/types/file-access.ts`.
//!
//! All types here are serializable via `serde` so they can cross the N-API
//! FFI boundary without allocation overhead on the JS side.

use serde::{Deserialize, Serialize};

/// Orthogonal approval policy that gates user-prompt interaction.
/// Mirrors `ToolApprovalPolicy` in shared/types/automation.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolApprovalPolicy {
    Off,
    Safe,
    Strict,
    Paranoid,
}

impl Default for ToolApprovalPolicy {
    fn default() -> Self {
        Self::Safe
    }
}

/// Agent operation mode.  Mirrors `AgentMode` in shared/types/automation.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    Normal,
    Plan,
    Auto,
}

impl Default for AgentMode {
    fn default() -> Self {
        Self::Normal
    }
}

/// OS-level sandbox strength.  Mirrors `SandboxLevel` in shared/types/automation.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxLevel {
    Off,
    Permissive,
    Strict,
}

impl Default for SandboxLevel {
    fn default() -> Self {
        Self::Off
    }
}

/// File access grant.  Mirrors `FileAccessGrant` in shared/types/file-access.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileAccessGrant {
    pub path: String,
    pub access: FileAccessLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileAccessLevel {
    Read,
    ReadWrite,
}

/// The context passed to every sandbox operation.
/// Mirrors `SandboxContext` in src/main/services/sandbox/types.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxContext {
    /// Absolute path of the conversation workspace.
    pub workspace_path: String,
    /// Additional paths the user has explicitly granted read/write access to.
    #[serde(default)]
    pub file_access_grants: Vec<FileAccessGrant>,
    /// Extra allowed paths configured by the user in Settings.
    #[serde(default)]
    pub extra_allowed_paths: Vec<String>,
    /// Whether the sandboxed process may make outbound network connections.
    #[serde(default)]
    pub allow_network: bool,
    /// The active sandbox level.
    pub level: SandboxLevel,
}

/// Result of evaluating an operation against the active sandbox.
/// Mirrors `SandboxDecision` in src/main/services/sandbox/types.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxDecision {
    /// Whether the operation is allowed by the sandbox policy.
    pub allowed: bool,
    /// Human-readable explanation.  Surfaced in the tool result and approval card.
    pub reason: String,
    /// Which backend produced this decision, for diagnostics.
    pub backend: String,
}

/// A wrapped argv ready to be passed to `node-pty.spawn`.
/// Mirrors `WrappedCommand` in src/main/services/sandbox/types.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrappedCommand {
    /// The executable name (may be empty when the backend injects itself,
    /// e.g. `sandbox-exec` on macOS).
    pub command: String,
    /// Full argument vector.
    pub args: Vec<String>,
    /// Extra environment variables to set on the spawned process.
    #[serde(default)]
    pub env_overrides: std::collections::HashMap<String, Option<String>>,
    /// Profile blob used by the backend, for diagnostics.  Null on noop / Windows.
    pub profile: Option<String>,
}

impl Default for WrappedCommand {
    fn default() -> Self {
        Self {
            command: String::new(),
            args: Vec::new(),
            env_overrides: std::collections::HashMap::new(),
            profile: None,
        }
    }
}

/// Per-backend availability report.  Mirrors `SandboxBackendStatus`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxBackendStatus {
    pub backend: String,
    pub available: bool,
    pub last_error: Option<String>,
    pub platform: String,
    pub probed_at: Option<i64>,
}

/// Input shape for profile builders.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProfileInputs {
    pub workspace_path: String,
    #[serde(default)]
    pub extra_allowed_paths: Vec<String>,
    #[serde(default = "default_true")]
    pub allow_network: bool,
}

fn default_true() -> bool {
    true
}

/// Result of building both OS-specific profiles in one call.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GeneratedProfiles {
    pub darwin_sandbox_exec_profile: String,
    pub bubblewrap_args: Vec<String>,
}

/// Resolved sandbox policy after composition of user settings + agent mode.
/// Mirrors `ResolvedSandboxPolicy` in policy.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedSandboxPolicy {
    pub effective_approval_policy: ToolApprovalPolicy,
    pub effective_sandbox_level: SandboxLevel,
    pub sandbox_active: bool,
    pub effective_mode: AgentMode,
    pub note: Option<String>,
}

/// Result of a backend `probe()` call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeResult {
    pub available: bool,
    pub error: Option<String>,
}

/// User-configured sandbox knobs.  This is the FFI-side INPUT shape to
/// `resolve_sandbox_policy` (the JS `SandboxConfig` object).
///
/// It is intentionally a subset of [`SandboxContext`]: a `SandboxConfig`
/// describes what the *user wants* (e.g. `level: 'strict'`, `allowNetwork: false`)
/// while a `SandboxContext` describes the *resolved, fully-bound* execution
/// context passed to runtime decisions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxConfig {
    pub level: SandboxLevel,
    #[serde(default = "default_true")]
    pub allow_network: bool,
    #[serde(default)]
    pub extra_allowed_paths: Vec<String>,
    #[serde(default)]
    pub extra_command_patterns: Vec<String>,
}

/// Filesystem operation used in path decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FsOperation {
    Read,
    Write,
}
