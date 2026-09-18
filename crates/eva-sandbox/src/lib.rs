//! `eva-sandbox` — OS-level sandbox primitives for the Eva desktop agent.
//!
//! ## Crate structure
//!
//! | Module | Responsibility |
//! |--------|----------------|
//! | [`types`] | All domain types (`SandboxContext`, `SandboxDecision`, etc.) |
//! | [`policy`] | `resolve_sandbox_policy()` — pure policy composition |
//! | [`profile`] | `build_darwin_profile()` / `build_bwrap_args()` — pure profile generation |
//! | [`decision`] | `path_decision()` / `default_command_decision()` — pure enforcement predicates |
//! | [`backends`] | Platform-specific backends with async `probe()` |
//!
//! ## FFI / N-API
//!
//! When compiled as a `cdylib`, this crate exposes a N-API surface
//! (`napi_*` functions) that the TypeScript sandbox service imports directly
//! via `require('eva-sandbox')`.  See `src/napi.rs` for the JS-callable layer.

#![cfg_attr(docsrs, feature(doc_cfg))]

pub mod types;
pub mod policy;
pub mod profile;
pub mod decision;

pub mod backends;
pub mod napi;

// Re-export the most commonly used items so callers can do `use eva_sandbox::{...}`.
pub use policy::resolve_sandbox_policy;
pub use profile::{build_bubblewrap_args, build_darwin_sandbox_exec_profile};
pub use decision::{default_command_decision, path_decision, SandboxBackendName};
pub use types::{
    AgentMode, FileAccessGrant, FileAccessLevel, FsOperation, GeneratedProfiles,
    ProbeResult, ProfileInputs, ResolvedSandboxPolicy, SandboxBackendStatus,
    SandboxConfig, SandboxContext, SandboxDecision, SandboxLevel,
    ToolApprovalPolicy, WrappedCommand,
};
