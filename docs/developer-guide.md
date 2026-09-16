# AgentChaos 开发者手册

给要改控制面、helper 或加故障类型的人。产品背景见 [design.md](./design.md)，分层见 [technical.md](./technical.md)。用户怎么跑实验见 [user-guide.md](./user-guide.md)。对接新 CLI 见 [cli-adapter.md](./cli-adapter.md)。Cursor / 协作者约定见仓库根目录 [AGENTS.md](../AGENTS.md)。

## 1. 职责边界（必须遵守）

**TypeScript 控制面**（`packages/runner`）

- Codex / Claude / Kimi / ZCode / generic-cli adapter
- YAML 实验模型、校验、调度
- LLM / MCP / CONNECT 代理
- 事件、断言、报告、CLI

**Rust helper**（`helper/`，二进制 `agentchaos-helper`）

- 进程树发现与清理
- pause / resume（Unix 信号，Windows 线程挂起）
- Windows Job Object
- 文件锁（flock / LockFileEx）、只读属性
- CPU / 内存压力
- Unix PTY / Windows ConPTY（`pty-spawn`）
- 以后：macOS / Windows 桌面系统 API

不要把 YAML 解析、Codex 参数拼接、断言逻辑放进 Rust。不要在 TypeScript 里直接 `kill(-pid)` 或解析 `ps`。

## 2. 仓库结构

```text
packages/runner/src/
  cli.ts           CLI：setup / init / validate / run / view / suite / workflow / watch / replay / list / report / recover
  view.ts          本地评测 viewer
  report.ts        report.json / report.html / report.md
  spec.ts          实验模型与旧格式兼容
  compose.ts       Workload / ChaosProfile 引用展开
  suite.ts         pass^k 套件
  workflow.ts      串行 / 并行工作流
  capabilities.ts  能力发现与风险预览
  observe.ts       workspace hash、git 状态、grader
  runner.ts        调度主循环
  adapters.ts      agent 启动计划
  faults.ts        故障注入
  proxy.ts         CONNECT + LLM HTTP 代理
  helper.ts        调用 agentchaos-helper
  dryrun.ts        --dry-run 计划
  yaml-loc.ts      YAML 行号
  assertions.ts    结束时检查
  events.ts        JSONL
  workspace.ts     隔离工作区与 fixture
helper/src/
  main.rs          helper CLI（JSON stdout；pty-spawn 握手在 stderr）
  process.rs       进程树（Unix ps + 信号）
  pty.rs           Unix PTY / 调用 Windows ConPTY
  win.rs           Windows 10+ Job Object / Toolhelp / 锁 / ConPTY
  resource.rs      CPU / 内存 / flock / chmod
examples/          用户可跑的实验
docs/              设计与手册
```

根目录 `Cargo.toml` 是 workspace，成员只有 `helper`。根目录 `package.json` 用 npm workspaces 挂 `packages/*`。

遗留的 `agentchaos.py` 不是生产 runner，不要继续加功能。

## 3. 本地开发

依赖：Node 22+、Cargo、Git。仓库根目录：

**Windows 10+**

```bat
scripts\setup.cmd
.\agentchaos.cmd validate examples\codex-smoke.yaml
npm test
```

**macOS / Linux**

```bash
./scripts/setup.sh
./agentchaos validate examples/codex-smoke.yaml
npm test
```

helper 产物：

- Unix：`target/debug/agentchaos-helper`
- Windows：`target/debug/agentchaos-helper.exe`

控制面用 `HelperClient.discover()` 查找，可用 `AGENTCHAOS_HELPER` 覆盖。

TypeScript 用 `node --experimental-strip-types` 直接跑 `.ts`，**不要**写 `constructor(private x)` 这类参数属性，也不要把 `??` 和 `||` 混在同一表达式且不加括号。

改完后至少跑：

```bash
npm test
```

测真实 Codex（需登录）：

**Windows**

```bat
.\agentchaos.cmd run examples\codex-process-kill.yaml
```

**macOS / Linux**

```bash
./agentchaos run examples/codex-process-kill.yaml
```

CI：`.github/workflows/ci.yml`，矩阵 `macos-latest` / `ubuntu-latest` / `windows-latest`。

## 4. 一次 run 怎么走

```text
loadSpec → validate → prepareWorkspace
  → 如需要则启动 network / llm proxy
  → planLaunch（adapter）
  → spawn agent（cwd = 隔离 workspace）
  → 循环：到点 injectFault，到点 recover
  → timeout 则 helper kill-tree
  → finally：恢复故障、再 kill-tree、停 proxy
  → assertions → report.json + report.html
```

调度在 `runner.ts`：`atMs == 0` 的非 process 故障在 spawn **之前**注入（例如 llm.429、git.lock）；process 故障等 pid 存在。每次注入后写 `shadow_compare`（harness 已注入、workspace hash、git lock、进程是否活着）。`file.edit` 可带 `sizeBytes`；`llm.401` 模拟 token 过期；`resource.port` 占用 TCP 端口（不走 helper）。

事件写 JSONL，字段：`ts`、`run_id`、`event_id`、`event`、`state?`、`detail`。

## 5. Helper IPC

helper 是一次性子进程，stdout 一行 JSON。成功大致为 `{"ok":true,...}`，失败 `{"ok":false,"error":"..."}` 且退出码非 0。

```text
agentchaos-helper caps
agentchaos-helper list-tree <pid>
agentchaos-helper kill-tree <pid>
agentchaos-helper pause-tree <pid>
agentchaos-helper resume-tree <pid>
agentchaos-helper cpu-stress --duration-ms N --threads N
agentchaos-helper mem-stress --duration-ms N --mb N
agentchaos-helper flock --path P --duration-ms N
agentchaos-helper acl --path P --mode 000
agentchaos-helper pty-spawn --cwd DIR -- executable [args...]
```

`pty-spawn` 在 stderr 打一行 `{"ok":true,"pid":...,"pty":true}`，随后 stdout 是终端字节流；stdin 写到 PTY/ConPTY。不要在 helper 里解析 YAML。

加 helper 命令时：

1. `helper/src` 实现，stdout 只打 JSON
2. `HelperClient` 包一层
3. `caps` 里登记能力
4. Unix 与 Windows 都要有行为或明确 `bail!("unsupported")`

Windows 实现放 `helper/src/win.rs`，用 `windows-sys`，不要再壳一层 `wmic` / `taskkill`（杀树用 Job Object + `TerminateProcess`）。

## 6. 加一种故障

1. `spec.ts`：类型 + `normalizeFault`（含旧名兼容，如 `process_kill`）
2. `faults.ts`：`inject*`，返回 `recover` 函数；有 `duration` 时 runner 会在到期调用
3. 路径类故障必须 `assertInsideWorkspace`
4. 需要 OS 能力则走 helper，不要在 TS 里发信号
5. `examples/` 加 YAML；能用 `generic-cli` + `node` 的不要依赖 Codex
6. `packages/runner/test/control-plane.test.ts` 加断言
7. 更新用户手册故障表

可恢复故障（pause、proxy、git.lock）必须能在 `finally` 里恢复，避免污染后续实验。

## 7. 加一个 adapter

对接步骤、generic-cli 试跑、具名 adapter 清单和 Codex / ZCode 对照见 [cli-adapter.md](./cli-adapter.md)。

`adapters.ts` 的 `planLaunch` 只返回启动计划。故障仍走 `faults.ts` + helper。`generic-cli` 有 `executable` 就直接 spawn；只有 `command` 时 Unix 走 `/bin/sh -lc`，Windows 走 `cmd.exe /d /s /c`。跨平台示例一律用 `executable` + `args`。

## 8. 实验模型

`normalizeSpec` 同时接受：

- `apiVersion: agentchaos.dev/v1alpha1` + `spec:`
- 扁平旧格式（`target.executable`、`type: process_kill`）

时长：数字 = 秒；字符串 `250ms` / `2s` / `1m` / `1h`。内部统一毫秒。

改 schema 时保持旧实验能跑，或在 `normalizeFault` 做别名。

## 9. 测试约定

- 控制面测试不要依赖真实 LLM 账号
- 用 `examples/*.yaml` 当契约，避免测试与示例分叉
- helper 单测：Unix 解析 `ps`；Windows 杀 `cmd ping`（`#[cfg(windows)]`）
- 不要用「sleep 很久」当通过条件，用事件和文件断言

## 10. 平台差异

| 能力 | macOS / Linux | Windows 10+ |
| --- | --- | --- |
| 进程枚举 | `ps` | Toolhelp32 |
| kill | SIGKILL + 进程组 | Job Object + TerminateProcess |
| pause | SIGSTOP / SIGCONT | SuspendThread / ResumeThread |
| 文件锁 | flock | LockFileEx |
| chmod | POSIX mode | 只读属性 |
| spawn | `detached` 新会话 | 不 detached，`windowsHide` |
| Codex 发现 | ChatGPT.app + PATH | LOCALAPPDATA / npm / PATH |

未实现（不要在文档里写成已支持）：UI Automation、UAC 向导、真正的轨迹 replay。PTY/ConPTY 已通过 `pty-spawn` 接入；缺能力时 runner 降级为管道。

## 11. 提交时注意

- 不要提交 `.agentchaos-runs/`、`node_modules/`、`target/`
- 不要把真实 session、token、用户仓库路径写进示例
- 示例 prompt 使用隔离 fixture 上的真实失败测试（改代码 / 跑测试 / Git），不要「等待 N 秒」
- 用户手册与 `examples/` 行为保持一致

## 12. 建议改动顺序

新稳定性问题优先：

1. 能否用现有故障类型写成 YAML？能则只加 example
2. 新的 agent CLI？先 `generic-cli` 试通，再按 [cli-adapter.md](./cli-adapter.md) 写具名 adapter
3. 只是断言不够？改 `assertions.ts`
4. 需要 OS 原语？改 helper，再从 TS 调用
5. 最后才动 `runner.ts` 主循环
