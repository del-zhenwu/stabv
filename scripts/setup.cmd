@echo off
setlocal
cd /d "%~dp0\.."

where node >nul 2>&1
if errorlevel 1 (
  echo missing node. Install Node.js 22+: https://nodejs.org
  exit /b 1
)
where cargo >nul 2>&1
if errorlevel 1 (
  echo missing cargo. Install Rust: https://rustup.rs
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo Node.js 22+ required
  node -v
  exit /b 1
)

echo - npm install
call npm install
if errorlevel 1 exit /b 1

echo - cargo build -p agentchaos-helper
cargo build -p agentchaos-helper
if errorlevel 1 exit /b 1

echo - agentchaos setup
node --experimental-strip-types packages/runner/src/cli.ts setup
if errorlevel 1 exit /b 1

echo.
echo Ready.
echo   .\agentchaos.cmd run examples\codex-smoke.yaml
echo   .\agentchaos.cmd view --open
