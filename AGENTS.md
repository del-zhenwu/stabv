# AgentChaos

Chaos experiments for coding agents. **macOS and Windows 10+** share the same YAML; do not treat Unix as the only platform.

Full docs: [docs/user-guide.md](docs/user-guide.md), [docs/cli-adapter.md](docs/cli-adapter.md), [docs/developer-guide.md](docs/developer-guide.md), [docs/design.md](docs/design.md) (product shape and boundaries), [docs/roadmap.md](docs/roadmap.md) (capability gaps).

## Platforms

| | macOS / Linux | Windows 10+ |
| --- | --- | --- |
| Setup | `./scripts/setup.sh` | `scripts\setup.cmd` (cmd or PowerShell) |
| Entry | `./agentchaos` | `.\agentchaos.cmd` |
| Helper | `target/debug/agentchaos-helper` | `target/debug/agentchaos-helper.exe` |
| Kill tree | SIGKILL + process group | Job Object + `TerminateProcess` |
| Pause | SIGSTOP / SIGCONT | `SuspendThread` / `ResumeThread` |
| File lock | flock | `LockFileEx` |
| chmod | POSIX mode | read-only attribute |
| Specs | `executable` + `args` | same; do **not** use POSIX `command:` |

Document install as two separate three-line blocks (Windows vs macOS), not comments after each other. `npx agentchaos` still works. Set `CODEX_BIN` if Codex is not on `PATH`.

Not implemented yet: UI Automation, UAC wizard. CLI PTY/ConPTY is helper `pty-spawn`; default experiments still use pipes unless `target.pty: true`.

## Layers (do not mix)

- **TypeScript** (`packages/runner`): YAML, adapters, workflow, proxy, events, assertions, CLI, reports.
- **Rust** (`helper/`): process trees, PTY/ConPTY, Job Objects, native APIs, resource pressure, helper IPC.

Do not parse YAML or build Codex argv in Rust. Do not `kill(-pid)` or parse `ps` in TypeScript.

Primary UX is CLI / CI / YAML plus `./agentchaos view` / `.\agentchaos.cmd view`. Do not invent a desktop app as the main product.

## Out of scope

- Do not replace SWE-bench or treat model quality as the only success metric.
- Helper must not orchestrate experiments.
- Do not inject faults into a real user home directory unless the spec explicitly opts in.
- Do not fake antivirus / Defender interception.
- Product shape (CLI primary; Dashboard/CI later, same runner API) lives in [docs/design.md](docs/design.md), not the roadmap.

## Implementation order (no dates)

Dependency order only. Details: [docs/roadmap.md](docs/roadmap.md).

1. Complete non-Codex CLI adapters (PTY/ConPTY is in the helper). No desktop permissions.
2. Native events, MCP proxy, approval/compaction faults (still CLI black-box).
3. Git worktree / disk / handles, metrics/evidence, schema, compare.
4. Versioned helper release + Mac/Windows desktop bridges, then `generic-desktop`.
5. Endurance runner and live viewer; Dashboard / CI Action / npm follow [docs/design.md](docs/design.md) and must not replace the CLI as the primary entry.

When adding a CLI agent: follow [docs/cli-adapter.md](docs/cli-adapter.md). Prefer a `generic-cli` YAML first; then a named adapter. Do not parse YAML in the helper.

When adding a feature: prefer a YAML example on existing faults; then assertions; then helper OS primitives; last, `runner.ts`.

## TypeScript

Run with `node --experimental-strip-types`. No constructor parameter properties. Do not mix `??` and `||` in one expression without parentheses.

## Examples and tests

Control-plane tests must not need a real LLM login. Cross-platform harness stubs use `executable` + `args` and `generic-cli` + Node. Product examples (`examples/codex-*.yaml`, `examples/zcode-*.yaml`) use a real failing fixture; see [docs/scenarios.md](docs/scenarios.md).
