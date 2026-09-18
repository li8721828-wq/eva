# eva-sandbox

OS-level sandbox primitives for the Eva desktop agent, implemented in Rust.

## Why Rust?

The sandbox subsystem is the single highest-ROI component to port because:

1. **Real OS isolation**: macOS `sandbox-exec` and Linux `bubblewrap` already give us
   kernel-level enforcement, but on Windows the current v1 implementation has no
   native wrap. With Rust + Windows API bindings we can add proper AppContainer
   isolation (the project already has a follow-up ticket for this).
2. **Crash safety**: A bug in the policy layer cannot crash the Electron main
   process and take down the user's session.
3. **Performance**: Path and command decisions are called on every file I/O and
   every shell spawn; Rust's no-allocation paths make this faster than TS.

## Layout

```
crates/eva-sandbox/
├── Cargo.toml         - manifest, dependencies, features
├── src/
│   ├── lib.rs         - crate entry, re-exports
│   ├── types.rs       - domain types (SandboxContext, SandboxDecision, etc.)
│   ├── policy.rs      - resolve_sandbox_policy() — pure composition
│   ├── profile.rs     - build_darwin_profile(), build_bwrap_args()
│   ├── decision.rs    - path_decision(), default_command_decision()
│   ├── backends/
│   │   ├── mod.rs
│   │   ├── noop.rs    - always-available backend
│   │   ├── darwin.rs  - sandbox-exec (macOS)
│   │   └── linux.rs   - bwrap (Linux)
│   └── napi.rs        - N-API FFI surface
```

## Building

### Prerequisites

- Rust 1.83+ (`rustup default stable`)
- Node.js 20+ (for the TypeScript wrapper)
- `napi` CLI: `npm install --save-dev @napi-rs/cli`

### One-time setup

```bash
# 1. Install Rust if you haven't
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. Install the napi build helper
npm install

# 3. Build the native module
npm run build:rust
```

The `build:rust` script produces a platform-specific binary:

| Platform | Output |
|----------|--------|
| Linux x64 | `native/eva_sandbox.linux-x64-gnu.node` |
| macOS x64 | `native/eva_sandbox.darwin-x64.node` |
| macOS arm64 | `native/eva_sandbox.darwin-arm64.node` |
| Windows x64 | `native/eva_sandbox.win32-x64-msvc.node` |

These files are committed to the repo so CI doesn't need Rust toolchain.

### Testing

```bash
# Unit tests (pure logic only — runs on any platform)
npm run test:rust

# Or per-crate:
cd crates/eva-sandbox
cargo test

# Lints
npm run clippy
```

### Adding a new function

1. Add the function to the appropriate module in `src/`.
2. If it needs FFI: add a `#[napi]` wrapper in `src/napi.rs`.
3. Add a TypeScript declaration in `src/main/services/sandbox/native.ts`.
4. Add a unit test in the same module.
5. Run `cargo test` then `npm run build:rust`.

## Module responsibilities

| Module | What it does | Pure? |
|--------|--------------|-------|
| `policy` | Merges `ToolApprovalPolicy` + `SandboxConfig` + `AgentMode` into the effective policy | ✅ Yes |
| `profile` | Generates macOS `sandbox-exec` S-expression and Linux `bwrap` argv | ✅ Yes |
| `decision` | `path_decision()` + `default_command_decision()` — pure predicates | ✅ Yes |
| `backends/noop` | Trivial backend, always available | ✅ Yes |
| `backends/darwin` | `probe()` async; `wrap()` pure | Mixed |
| `backends/linux` | `probe()` async; `wrap()` pure | Mixed |

## Integration with the existing TS service

`src/main/services/sandbox/native.ts` is the single entry point for TS code.
It `require('eva_sandbox')` (the compiled `.node` binary) and re-exports typed
functions that mirror the old TS API.

The existing `src/main/services/sandbox/index.ts` can switch its imports
from `./backends/darwin` / `./backends/linux` / `./backends/noop` to `./native`
without changing any caller's code (the function signatures are identical).

### Migration plan

1. **Phase 1 (this crate)**: sandbox primitives in Rust, behind a TS shim.
2. **Phase 2 (future)**: agent-runner + tool execution in Rust as a sidecar
   process. Communicate via JSON over a localhost Unix socket / named pipe.

## Why not just rewrite the whole project in Rust?

Because the UI is Electron + React (the renderer MUST stay web-tech).  A full
rewrite would either lose the UI or rewrite it in Dioxus/Tauri (6+ extra
months).  Phasing the port — sandbox first, then agent engine — keeps the UI
shippable while we collect the safety/perf wins where they matter most.
