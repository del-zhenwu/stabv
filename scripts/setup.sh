#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing $1. $2" >&2
    exit 1
  fi
}

need node "Install Node.js 22+: https://nodejs.org"
need cargo "Install Rust: https://rustup.rs"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ required (found $(node -v))" >&2
  exit 1
fi

echo "→ npm install"
npm install
echo "→ cargo build -p agentchaos-helper"
cargo build -p agentchaos-helper
echo "→ agentchaos setup"
node --experimental-strip-types packages/runner/src/cli.ts setup

echo
echo "Ready (contributor checkout)."
echo "  Users install with: npm install -g agentchaos"
echo "  ./agentchaos run examples/probe/codex-smoke.yaml"
echo "  ./agentchaos view --open"
