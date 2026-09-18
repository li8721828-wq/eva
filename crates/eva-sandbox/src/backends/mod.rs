//! Platform-specific sandbox backends.
//!
//! Each backend implements `SandboxBackend` semantics:
//!   - `probe()`: probe that the OS sandbox binary is available (sync).
//!   - `wrap()`: builds a `WrappedCommand` argv (sync, pure function).
//!   - `evaluate_*()`: pure predicates (delegated to `decision.rs`).
//!
//! All backend operations are sync — the `#[napi] async fn` wrappers in
//! `crate::napi` handle async wrapping at the FFI boundary using napi-rs's
//! worker-thread executor.  This avoids dragging tokio into the FFI layer.

pub mod noop;
pub mod darwin;
pub mod linux;
