$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Need($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Error "missing $name. $hint"
  }
}

Need node "Install Node.js 22+: https://nodejs.org"
Need cargo "Install Rust: https://rustup.rs"

$major = [int]((node -p "process.versions.node.split('.')[0]"))
if ($major -lt 22) {
  Write-Error "Node.js 22+ required (found $(node -v))"
}

Write-Host "-> npm install"
npm install
Write-Host "-> cargo build -p agentchaos-helper"
cargo build -p agentchaos-helper
Write-Host "-> agentchaos setup"
node --experimental-strip-types packages/runner/src/cli.ts setup

Write-Host ""
Write-Host "Ready."
Write-Host "  .\agentchaos.cmd run examples\codex-smoke.yaml"
Write-Host "  .\agentchaos.cmd view --open"
