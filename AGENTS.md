# AgentChaos

Chaos experiments for coding agents. **macOS and Windows 10+** share the same YAML; do not treat Unix as the only platform.

Full docs: [docs/user-guide.md](docs/user-guide.md), [docs/cli-adapter.md](docs/cli-adapter.md), [docs/developer-guide.md](docs/developer-guide.md), [docs/agent-guidelines.md](docs/agent-guidelines.md) (agent rules), [docs/design.md](docs/design.md) (product shape and boundaries), [docs/roadmap.md](docs/roadmap.md) (capability gaps).

## Platforms

| | macOS / Linux | Windows 10+ |
| --- | --- | --- |
| User install | `npm install -g agentchaos`；`agentchaos run examples/zcode.yaml` | same |
| Contributor setup | `./scripts/setup.sh` | `scripts\setup.cmd` (cmd or PowerShell) |
| Contributor entry | `./agentchaos` | `.\agentchaos.cmd` |
| Helper | `target/debug/agentchaos-helper` | `target/debug/agentchaos-helper.exe` |
| Kill tree | SIGKILL + process group | Job Object + `TerminateProcess` |
| Pause | SIGSTOP / SIGCONT | `SuspendThread` / `ResumeThread` |
| File lock | flock | `LockFileEx` |
| chmod | POSIX mode | read-only attribute |
| Specs | `executable` + `args` | same; do **not** use POSIX `command:` |

User-facing install is npm (`agentchaos`), two separate three-line blocks (Windows vs macOS). Clone + `./agentchaos` is for contributors. Do not document Docker or SaaS as the product. Set `CODEX_BIN` if Codex is not on `PATH`. Changing `helper/` must refresh `prebuilt/` via `.github/workflows/prebuilt-helper.yml`; do not tell users to install Rust.

Implemented native primitives: desktop window close and text input via Accessibility/UI Automation; full desktop adapter, renderer state and UAC wizard are not implemented yet. CLI PTY/ConPTY is helper `pty-spawn`; default experiments still use pipes unless `target.pty: true`.

## Layers (do not mix)

- **TypeScript** (`packages/runner`): YAML, adapters, workflow, proxy, events, assertions, CLI, reports.
- **Rust** (`helper/`): process trees, PTY/ConPTY, Job Objects, native APIs, resource pressure, helper IPC.

Do not parse YAML or build Codex argv in Rust. Do not `kill(-pid)` or parse `ps` in TypeScript.

Primary UX is CLI / CI / YAML plus `./agentchaos view` / `.\agentchaos.cmd view`. Do not invent a desktop app as the main product.

## Design principles

0. **Start from how the user writes YAML and how they read the report**:
   - User config is one file: who runs (`target.adapter`) + what to inject (`inject`). Default is `examples/zcode.yaml` (zcode + all catalog kinds). The runner expands the combination. Do not ask users to list every agent × fault file.
   - The report title is that combination (`zcode × llm / resource / file / …`); cases underneath are each injection. Viewer tasks nest those cases.
   - Internals (`workloads/`, `profiles/`) exist so the catalog can grow. They are not the primary UX.

1. **Modern Adapter Contracts over Ad-hoc Paths (Harbor Pattern)**:
   - All agents are registered via declarative `AgentDescriptor` contracts with CLI templates, environment variable mappings, and capability flags.
   - Deterministic 4-level executable resolution: explicit `target.executable` > ENV var override (`XXX_BIN`) > system `PATH` > standard global package manager binaries.
   - Never hardcode private app bundle paths (e.g. `/Applications/*.app/Contents/Resources/...` or internal desktop resources) into the core runner. Reverse-engineering discovery belongs strictly in external probe skills (`.cursor/skills/agentchaos-adapter-probe`), not the core execution engine.

2. **Strongly-typed Protocol Matching over Fuzzy Regex (Zero Haystack Regex)**:
   - Never concatenate JSON event fields into a string haystack and run loose regular expressions (`/approval/`, `/item\.completed/`). Natural language conversation text or user prompts containing these keywords cause false positives.
   - Event classification (`native-events.ts`) must use typed Tagged Union matching specific to each protocol (Codex item types, Anthropic SSE/content blocks, JSON-RPC control events).

3. **Dual-Track Chaos: Physical & AI-Native Cognitive Chaos**:
   - Coding agents are not just classic distributed nodes; they are cognitive systems with instruction following, rule retention, and context memory.
   - Rule and context faults are first-class citizens alongside OS faults: `rule.conflict` (instruction defense), `rule.evict` (memory/rule retention), `rule.corrupt` (semantic inversion), `context.poison` (fake tool outputs & hallucination defense), and `context.truncate`.

4. **`mode: auto` planner (not a second scoring agent)**:
   - YAML `mode: auto` lets an LLM planner call observe / strike / stop. That planner injects faults; it does not grade the run.
   - Verdicts stay empirical (`fault_injected`, invariants, process/git/workspace). Replay with `agentchaos replay <run-id>` from recorded strikes.
   - Do not add a second planner engine beside `mode: auto`.

5. **Strict Evidence Provenance Separation & Dual Diagnosis**:
   - Three-tiered truth: `[EMPIRICAL]` (real OS/API/proxy facts), `[STATIC_PROBE]` (probe skill inference), `[AGENT_INFERENCE]` (causal deduction). Never disguise reverse-engineered assumptions as empirical test findings.
   - Dual output: rich visual Web Viewer for humans; structured `report.diagnosis.json` (invariants violated, causal chain, suggested fix patterns) for coding agents.

6. **Transparent Passthrough MITM Proxying**:
   - `LlmProxy` supports transparent upstream forwarding (`AGENTCHAOS_LLM_UPSTREAM`) when no faults are active, seamlessly intercepting during fault injection windows to validate true end-to-end task recovery.

7. **Watchdog Resilience (Anti-Deadlock & Anti-Churn)**:
   - Detect both silent I/O hangs (`watchdog_io_stalled`) and runaway error loops (`watchdog_retry_storm` / `RETRY_STORM_DEADLOCK`), preventing harness timeouts from waiting passively.

## Out of scope

- Do not replace SWE-bench or treat model quality as the only success metric.
- Helper must not orchestrate experiments.
- Do not inject faults into a real user home directory unless the spec explicitly opts in.
- Do not fake antivirus / Defender interception.
- Product shape (CLI primary; Dashboard/CI later, same runner API) lives in [docs/design.md](docs/design.md), not the roadmap.

## Implementation order (no dates)

Dependency order only. Details: [docs/roadmap.md](docs/roadmap.md).

1. Remaining CLI adapters (OpenCode / Cursor CLI / Zed/ACP). PTY/ConPTY, Claude, and Kimi argv are in.
2. Cancel races, post-compaction drift (PTY, native events, MCP HTTP/stdio, Anthropic Messages, approval/compaction interrupt, subagent chaos are in).
3. Handles / massive stdout, metrics/evidence, schema, compare (Git worktree / disk stress are in).
4. Versioned helper release + Mac/Windows desktop bridges, then `generic-desktop`.
5. Endurance runner and live viewer; Dashboard / CI Action / npm follow [docs/design.md](docs/design.md) and must not replace the CLI as the primary entry.

When adding a CLI agent: follow [docs/cli-adapter.md](docs/cli-adapter.md). Prefer a `generic-cli` YAML first; then a named adapter. Do not parse YAML in the helper.

When adding a feature: prefer a YAML example on existing faults; then assertions; then helper OS primitives; last, `runner.ts`.

## TypeScript

Run with `node --experimental-strip-types`. No constructor parameter properties. Do not mix `??` and `||` in one expression without parentheses.

## Examples and tests

Control-plane tests must not need a real LLM login. Cross-platform harness stubs use `executable` + `args` and `generic-cli` + Node. Product examples pair `examples/workloads/` with `examples/profiles/` (same fixture). Control-plane stubs live in `examples/probe/`. See [docs/scenarios.md](docs/scenarios.md) and [examples/README.md](examples/README.md).
