//! N-API (Node.js / Electron) FFI surface for `eva-sandbox`.
//!
//! All functions here are `#[napi]` annotated so `cargo-napi` generates a
//! `eva_sandbox.node` native addon when built.  The TypeScript sandbox
//! service will `require('eva_sandbox')` and call these functions directly,
//! replacing the TS implementations in `backends/*.ts`.
//!
//! ## Design notes
//!
//! - `#[napi]` structs must implement `Send + Sync` — our types are all simple
//!   `Clone + Send + Sync` so this constraint is satisfied.
//! - `#[napi] async fn` is handled by napi-rs's built-in executor; no tokio
//!   runtime is required.
//! - All `#[napi]` functions take owned `String` / `Vec` parameters; the
//!   serializer handles conversion from JS strings/arrays without extra copies.
//! - For JS object parameters we use the `#[napi(object)]` derive to get
//!   automatic conversion from JS objects to Rust structs (instead of
//!   manually reading fields via `Object::get`).

use napi::bindgen_prelude::*;
// `#[napi]` is a proc-macro attribute re-exported from `napi-derive`.
// We import it here so the rest of the file can just write `#[napi]` /
// `#[napi(object)]` without a fully-qualified path.
use napi_derive::napi;
use crate::types::*;

// ---------------------------------------------------------------------------
// JS-side wrapper types
// ---------------------------------------------------------------------------
//
// These mirror the shape of the JS objects passed by the TS sandbox service.
// We can't use the `#[napi(object)]` derive directly on the domain types in
// `crate::types` because those use `serde::Serialize` for JSON-over-FFI and
// we don't want to entangle the two serializers.  Instead we define thin
// FFI-side structs here and convert manually in each function body.

/// Mirrors the JS `SandboxConfig` shape.
#[napi(object)]
pub struct JsSandboxConfig {
    pub level: Option<String>,
    pub allow_network: Option<bool>,
    pub extra_allowed_paths: Option<Vec<String>>,
    pub extra_command_patterns: Option<Vec<String>>,
}

impl JsSandboxConfig {
    fn into_config(self) -> Result<SandboxConfig> {
        let level_str = self.level.unwrap_or_else(|| "off".to_string());
        let level = parse_sandbox_level(&level_str)?;
        Ok(SandboxConfig {
            level,
            allow_network: self.allow_network.unwrap_or(true),
            extra_allowed_paths: self.extra_allowed_paths.unwrap_or_default(),
            extra_command_patterns: self.extra_command_patterns.unwrap_or_default(),
        })
    }
}

/// Mirrors the JS `ProfileInputs` shape.
#[napi(object)]
pub struct JsProfileInputs {
    pub workspace_path: String,
    pub extra_allowed_paths: Option<Vec<String>>,
    pub allow_network: Option<bool>,
}

impl JsProfileInputs {
    fn into_inputs(self) -> ProfileInputs {
        ProfileInputs {
            workspace_path: self.workspace_path,
            extra_allowed_paths: self.extra_allowed_paths.unwrap_or_default(),
            allow_network: self.allow_network.unwrap_or(true),
        }
    }
}

/// Mirrors the JS `SandboxContext` shape (only the fields the FFI surface needs).
#[napi(object)]
pub struct JsSandboxContext {
    pub workspace_path: String,
    pub file_access_grants: Option<Vec<JsFileAccessGrant>>,
    pub extra_allowed_paths: Option<Vec<String>>,
    pub allow_network: Option<bool>,
    pub level: String,
}

impl JsSandboxContext {
    fn into_context(self) -> Result<SandboxContext> {
        Ok(SandboxContext {
            workspace_path: self.workspace_path,
            file_access_grants: self
                .file_access_grants
                .unwrap_or_default()
                .into_iter()
                .map(|g| g.into_grant())
                .collect(),
            extra_allowed_paths: self.extra_allowed_paths.unwrap_or_default(),
            allow_network: self.allow_network.unwrap_or(true),
            level: parse_sandbox_level(&self.level)?,
        })
    }
}

/// Mirrors the JS `FileAccessGrant` shape.
#[napi(object)]
pub struct JsFileAccessGrant {
    pub path: String,
    pub access: String,
}

impl JsFileAccessGrant {
    fn into_grant(self) -> FileAccessGrant {
        let access = match self.access.as_str() {
            "read" => FileAccessLevel::Read,
            _ => FileAccessLevel::ReadWrite,
        };
        FileAccessGrant {
            path: self.path,
            access,
        }
    }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/// Resolve the effective sandbox policy.
/// Mirrors `resolveSandboxPolicy` in policy.ts.
#[napi]
pub fn resolve_sandbox_policy_js(
    approval_policy: String,
    sandbox: JsSandboxConfig,
    mode: String,
) -> Result<String> {
    let policy = parse_tool_approval_policy(&approval_policy)?;
    let cfg = sandbox.into_config()?;
    let mode = parse_agent_mode(&mode)?;
    let result = crate::policy::resolve_sandbox_policy(policy, &cfg, mode);
    serde_json::to_string(&result)
        .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
}

/// Build both OS-specific profiles in one call.
#[napi]
pub fn build_profiles(inputs: JsProfileInputs) -> String {
    let inputs = inputs.into_inputs();
    let darwin = crate::profile::build_darwin_sandbox_exec_profile(&inputs);
    let bubblewrap = crate::profile::build_bubblewrap_args(&inputs);
    let result = GeneratedProfiles {
        darwin_sandbox_exec_profile: darwin,
        bubblewrap_args: bubblewrap,
    };
    serde_json::to_string(&result).unwrap()
}

// ---------------------------------------------------------------------------
// Path / Command decisions
// ---------------------------------------------------------------------------

/// Evaluate a filesystem path.  Mirrors `pathDecision` in darwin.ts.
#[napi]
pub fn path_decision_js(
    target_path: String,
    operation: String, // "read" | "write"
    context: JsSandboxContext,
    backend: String,
) -> String {
    let ctx = match context.into_context() {
        Ok(c) => c,
        Err(e) => return format!(r#"{{"error":"{}"}}"#, e.to_string()),
    };
    let op = if operation == "write" {
        FsOperation::Write
    } else {
        FsOperation::Read
    };
    let backend_name = parse_backend_name(&backend);
    let result = crate::decision::path_decision(&target_path, op, &ctx, backend_name);
    serde_json::to_string(&result).unwrap()
}

/// Evaluate a shell command.  Mirrors `defaultCommandDecision` in darwin.ts.
#[napi]
pub fn default_command_decision_js(
    command_line: String,
    context: JsSandboxContext,
    backend: String,
) -> String {
    let ctx = match context.into_context() {
        Ok(c) => c,
        Err(e) => return format!(r#"{{"error":"{}"}}"#, e.to_string()),
    };
    let backend_name = parse_backend_name(&backend);
    let result = crate::decision::default_command_decision(&command_line, &ctx, backend_name);
    serde_json::to_string(&result).unwrap()
}

// ---------------------------------------------------------------------------
// Backend probes (called once at startup + on Settings change)
// ---------------------------------------------------------------------------

/// Probe Darwin `sandbox-exec`.  Returns a JSON `ProbeResult`.
#[napi]
pub async fn probe_darwin() -> String {
    let result = crate::backends::darwin::probe();
    serde_json::to_string(&result).unwrap()
}

/// Probe Linux `bwrap`.  Returns a JSON `ProbeResult`.
#[napi]
pub async fn probe_linux() -> String {
    let result = crate::backends::linux::probe();
    serde_json::to_string(&result).unwrap()
}

/// Probe noop.  Always returns `{ available: true, error: null }`.
#[napi]
pub fn probe_noop() -> String {
    let result = crate::backends::noop::probe();
    serde_json::to_string(&result).unwrap()
}

/// Wrap argv for Darwin `sandbox-exec`.  Returns a JSON `WrappedCommand`.
#[napi]
pub fn wrap_darwin(command: String, args: Vec<String>, context: JsSandboxContext) -> String {
    let ctx = match context.into_context() {
        Ok(c) => c,
        Err(e) => return format!(r#"{{"error":"{}"}}"#, e.to_string()),
    };
    let result = crate::backends::darwin::wrap(&command, &args, &ctx);
    serde_json::to_string(&result).unwrap()
}

/// Wrap argv for Linux `bwrap`.  Returns a JSON `WrappedCommand`.
#[napi]
pub fn wrap_linux(command: String, args: Vec<String>, context: JsSandboxContext) -> String {
    let ctx = match context.into_context() {
        Ok(c) => c,
        Err(e) => return format!(r#"{{"error":"{}"}}"#, e.to_string()),
    };
    let result = crate::backends::linux::wrap(&command, &args, &ctx);
    serde_json::to_string(&result).unwrap()
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

fn parse_tool_approval_policy(s: &str) -> Result<ToolApprovalPolicy> {
    match s {
        "off" => Ok(ToolApprovalPolicy::Off),
        "safe" => Ok(ToolApprovalPolicy::Safe),
        "strict" => Ok(ToolApprovalPolicy::Strict),
        "paranoid" => Ok(ToolApprovalPolicy::Paranoid),
        _ => Err(Error::new(
            Status::InvalidArg,
            format!("unknown ToolApprovalPolicy: {}", s),
        )),
    }
}

fn parse_sandbox_level(s: &str) -> Result<SandboxLevel> {
    match s {
        "off" => Ok(SandboxLevel::Off),
        "permissive" => Ok(SandboxLevel::Permissive),
        "strict" => Ok(SandboxLevel::Strict),
        _ => Err(Error::new(
            Status::InvalidArg,
            format!("unknown SandboxLevel: {}", s),
        )),
    }
}

fn parse_agent_mode(s: &str) -> Result<AgentMode> {
    match s {
        "normal" => Ok(AgentMode::Normal),
        "plan" => Ok(AgentMode::Plan),
        "auto" => Ok(AgentMode::Auto),
        _ => Err(Error::new(
            Status::InvalidArg,
            format!("unknown AgentMode: {}", s),
        )),
    }
}

fn parse_backend_name(s: &str) -> crate::decision::SandboxBackendName {
    match s {
        "noop" => crate::decision::SandboxBackendName::Noop,
        "darwin-sandbox-exec" => crate::decision::SandboxBackendName::DarwinSandboxExec,
        "linux-bubblewrap" => crate::decision::SandboxBackendName::LinuxBubblewrap,
        _ => crate::decision::SandboxBackendName::Win32PolicyOnly,
    }
}
