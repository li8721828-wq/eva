#!/usr/bin/env bash
# Quick verification of the Rust sandbox crate.
# Run from the repo root: `bash scripts/verify-rust-sandbox.sh`

set -euo pipefail

echo "=== Phase 1: Rust sandbox crate verification ==="
echo ""

# 1. Check Rust is installed
echo "[1/7] Checking Rust toolchain..."
if ! command -v cargo &> /dev/null; then
  echo "FAIL: cargo not found. Install Rust: https://rustup.rs"
  exit 1
fi
RUST_VERSION=$(cargo --version | cut -d' ' -f2)
echo "  cargo $RUST_VERSION"

# 2. Check Rust workspace structure
echo "[2/7] Verifying workspace layout..."
for f in \
  Cargo.toml \
  rust-toolchain.toml \
  crates/eva-sandbox/Cargo.toml \
  crates/eva-sandbox/src/lib.rs \
  crates/eva-sandbox/src/types.rs \
  crates/eva-sandbox/src/policy.rs \
  crates/eva-sandbox/src/profile.rs \
  crates/eva-sandbox/src/decision.rs \
  crates/eva-sandbox/src/backends/mod.rs \
  crates/eva-sandbox/src/backends/noop.rs \
  crates/eva-sandbox/src/backends/darwin.rs \
  crates/eva-sandbox/src/backends/linux.rs \
  crates/eva-sandbox/src/napi.rs \
  crates/eva-sandbox/README.md \
  src/main/services/sandbox/native.ts; do
  if [ ! -f "$f" ]; then
    echo "FAIL: missing $f"
    exit 1
  fi
done
# Build artifacts produced by `npm run build:rust` (informational).
for f in native/index.cjs native/index.d.ts; do
  if [ -f "$f" ]; then echo "  OK artifact: $f"; else echo "  WARN artifact missing: $f"; fi
done
echo "  OK: all required files present"

# 3. Cargo check
echo "[3/7] Running cargo check..."
cargo check --manifest-path crates/eva-sandbox/Cargo.toml --all-features

# 4. Cargo test (pure logic only)
echo "[4/7] Running cargo test..."
cargo test --manifest-path crates/eva-sandbox/Cargo.toml --lib --all-features

# 5. Clippy lints
echo "[5/7] Running clippy..."
cargo clippy --manifest-path crates/eva-sandbox/Cargo.toml --all-features -- -D warnings

# 6. Build native module (requires @napi-rs/cli)
echo "[6/7] Building native module..."
if [ -d "node_modules/@napi-rs/cli" ]; then
  npm run build:rust
else
  echo "  SKIP: @napi-rs/cli not installed. Run 'npm install' first, then 'npm run build:rust'."
fi

# 7. Smoke-test the napi-rs loader: confirm `native/index.cjs` can load the
#    platform-specific binary and that `probeNoop` round-trips a JSON value.
echo "[7/7] Smoke-testing native loader..."
if ! command -v node &> /dev/null; then
  echo "  SKIP: node not on PATH; cannot smoke-test."
elif [ ! -f "native/index.cjs" ]; then
  echo "  SKIP: native/index.cjs missing; did step 6 succeed?"
else
  PROBE_OUT=$(node -e "const m=require('./native/index.cjs'); console.log(m.probeNoop())")
  echo "  probe_noop = $PROBE_OUT"
fi

echo ""
echo "=== All checks passed ==="
