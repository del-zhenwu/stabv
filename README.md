# AgentChaos

面向 coding agent 的声明式混沌实验。控制面是 TypeScript，Rust helper 负责进程树、信号、文件锁和资源压力。

**macOS 和 Windows 10+ 共用同一套 YAML。** Windows 上 helper 是 `agentchaos-helper.exe`。

- [用户手册](docs/user-guide.md)
- [稳定性实验](docs/scenarios.md)
- [对接 CLI](docs/cli-adapter.md)
- [开发者手册](docs/developer-guide.md)
- [AGENTS.md](AGENTS.md) — 仓库约定
- [Roadmap](docs/roadmap.md)（能力缺口）
- [设计](docs/design.md)（形态与边界）

## 平台

当前支持 **macOS** 和 **Windows 10+**（同一批实验）。Linux 上 CLI helper 可用；桌面 bridge 仍在 roadmap 里。

| | macOS / Linux | Windows 10+ |
| --- | --- | --- |
| 安装 | `./scripts/setup.sh` | `scripts\setup.cmd` |
| 入口 | `./agentchaos` | `.\agentchaos.cmd` |
| Helper | `agentchaos-helper` | `agentchaos-helper.exe` |
| 杀进程树 | 信号 | Job Object |
| 暂停 | SIGSTOP | `SuspendThread` |
| 文件锁 | flock | `LockFileEx` |

`./agentchaos` 与 `.\agentchaos.cmd` 都转到同一套 CLI。YAML 请用 `executable` + `args`（POSIX `command:` 在 Windows 上会失败）。`target.pty: true` 走 helper PTY/ConPTY；UI Automation 尚未实现。

## 安装与使用

需要 **Node.js 22+** 和 **Rust**（`cargo`）。仓库根目录执行。

**Windows 10+**

```bat
scripts\setup.cmd
.\agentchaos.cmd run examples\codex-smoke.yaml
.\agentchaos.cmd view --open
```

**macOS / Linux**

```bash
./scripts/setup.sh
./agentchaos run examples/codex-smoke.yaml
./agentchaos view --open
```

`setup` 会编译 helper、探测 Codex / Claude / Kimi / ZCode，并写入 `.agentchaos/capabilities.json`。Smoke 示例用 Node 替身，不需要 Codex。`view` 打开 http://127.0.0.1:8080。也可以用 `npx agentchaos`，主入口仍是上面的包装脚本。

| 命令 | 作用 |
| --- | --- |
| `agentchaos setup` | 编译 helper、发现 agent |
| `agentchaos run <spec>` | 跑实验 / Suite / Workflow |
| `agentchaos view --open` | 本地评测报告 |
| `agentchaos validate <spec>` | schema、引用文件与风险预览 |

测真实 Codex（需已登录；修失败测试中途杀进程再 resume）：

**Windows**

```bat
.\agentchaos.cmd run examples\codex-kill-resume.yaml
```

**macOS / Linux**

```bash
./agentchaos run examples/codex-kill-resume.yaml
```

测真实 ZCode（需已登录；会找 App 自带的 `zcode.cjs` 或 `PATH` 上的 `zcode`）：

**Windows**

```bat
.\agentchaos.cmd run examples\zcode-process-kill.yaml
```

**macOS / Linux**

```bash
./agentchaos run examples/zcode-process-kill.yaml
```

Codex 不在 `PATH` 时：

**Windows**

```powershell
$env:CODEX_BIN = "C:\path\to\codex.exe"
$env:ZCODE_BIN = "C:\path\to\zcode.cjs"
```

**macOS / Linux**

```bash
export CODEX_BIN=/path/to/codex
export ZCODE_BIN=/path/to/zcode.cjs
```

## 报告

每次 run 写在 `.agentchaos-runs/<id>/`：

- `report.html` — 评测页（分数、指标、trace）
- `report.json` / `report.md` — 给脚本和 CI
- `events.jsonl` — 完整时间线

## Windows 10+ 说明

实验文件跨平台共用。Helper 用 Job Object 杀进程树、`SuspendThread`/`ResumeThread` 做 pause、`LockFileEx` 做 `file.lock`、只读属性映射 `chmod`、ConPTY 跑 `target.pty`。规格里优先 `executable` + `args`。UI Automation 仍待做；默认 CLI 实验仍用管道。

CI 包含 `windows-latest`。

## 实现顺序

不绑定时间。能力缺口见 [docs/roadmap.md](docs/roadmap.md)，产品入口与边界见 [docs/design.md](docs/design.md)。按依赖推进：

1. 更完整的非 Codex CLI adapter（PTY/ConPTY 已接入）
2. 原生事件、MCP 代理、审批/压缩故障
3. 磁盘 / git worktree / 指标 / schema / compare
4. 版本化 helper + Mac/Windows 桌面 bridge，然后 `generic-desktop`
5. endurance、实时 viewer；Dashboard / CI / npm 按设计文档，且不取代 CLI 主入口

## 故障类型

| 类型 | 动作 |
| --- | --- |
| `process` | `kill`, `pause`, `restart` |
| `file` | `edit`, `delete`, `rename`, `chmod`, `symlink`, `lock` |
| `git` | `lock`, `conflict`, `switch-branch` |
| `network` | `delay`, `timeout`, `reset` |
| `llm` | `429`, `500`, `delay`, `timeout`, `malformed`, `truncate`, `schema_drift`, `duplicate` |
| `resource` | `cpu`, `memory` |
