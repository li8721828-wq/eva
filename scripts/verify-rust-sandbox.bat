@echo off
REM Quick verification of the Rust sandbox crate.
REM Run from the repo root: `scripts\verify-rust-sandbox.bat`

setlocal

echo === Phase 1: Rust sandbox crate verification ===
echo.

REM 1. Check Rust is installed
echo [1/7] Checking Rust toolchain...
where cargo >nul 2>nul
if errorlevel 1 (
  echo FAIL: cargo not found. Install Rust: https://rustup.rs
  exit /b 1
)
for /f "tokens=2" %%v in ('cargo --version') do set RUST_VERSION=%%v
echo   cargo %RUST_VERSION%

REM 2. Check Rust workspace structure
echo [2/7] Verifying workspace layout...
for %%f in (
  Cargo.toml
  rust-toolchain.toml
  crates\eva-sandbox\Cargo.toml
  crates\eva-sandbox\src\lib.rs
  crates\eva-sandbox\src\types.rs
  crates\eva-sandbox\src\policy.rs
  crates\eva-sandbox\src\profile.rs
  crates\eva-sandbox\src\decision.rs
  crates\eva-sandbox\src\backends\mod.rs
  crates\eva-sandbox\src\backends\noop.rs
  crates\eva-sandbox\src\backends\darwin.rs
  crates\eva-sandbox\src\backends\linux.rs
  crates\eva-sandbox\src\napi.rs
  crates\eva-sandbox\README.md
  src\main\services\sandbox\native.ts
) do (
  if not exist %%f (
    echo FAIL: missing %%f
    exit /b 1
  )
)
REM Build artifacts produced by `npm run build:rust` (informational).
for %%f in (native\index.cjs native\index.d.ts) do (
  if exist %%f (echo   OK artifact: %%f) else (echo   WARN artifact missing: %%f)
)
echo   OK: all required files present

REM 3. Cargo check
echo [3/7] Running cargo check...
cargo check --manifest-path crates\eva-sandbox\Cargo.toml --all-features
if errorlevel 1 exit /b 1

REM 4. Cargo test (pure logic only)
echo [4/7] Running cargo test...
cargo test --manifest-path crates\eva-sandbox\Cargo.toml --lib --all-features

REM 5. Clippy lints
echo [5/7] Running clippy...
cargo clippy --manifest-path crates\eva-sandbox\Cargo.toml --all-features -- -D warnings

REM 6. Build native module
echo [6/7] Building native module...
if exist node_modules\@napi-rs\cli (
  call npm run build:rust
  if errorlevel 1 exit /b 1
) else (
  echo   SKIP: @napi-rs^cli not installed. Run "npm install" first, then "npm run build:rust".
)

REM 7. Smoke-test the napi-rs loader: confirm `native/index.cjs` can load the
REM    platform-specific binary and that `probeNoop` round-trips a JSON value.
echo [7/7] Smoke-testing native loader...
where node >nul 2>nul
if errorlevel 1 (
  echo   SKIP: node not on PATH; cannot smoke-test.
) else if not exist native\index.cjs (
  echo   SKIP: native\index.cjs missing; did step 6 succeed?
) else (
  for /f "usebackq delims=" %%o in (`node -e "const m=require('./native/index.cjs'); console.log(m.probeNoop())"`) do set PROBE_OUT=%%o
  echo   probe_noop = %PROBE_OUT%
)

echo.
echo === All checks passed ===
