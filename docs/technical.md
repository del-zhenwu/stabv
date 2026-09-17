# AgentChaos 技术文档

## 总体架构

```text
Experiment YAML / CLI / CI
          |
          v
   AgentChaos Controller
          |
   +------+-------+---------+
   |      |       |         |
 Proxy Process Workspace Observer
 Adapter Adapter  Adapter   |
          |                 |
          v                 v
       被测 Agent       Assertions/Report
```

控制面负责解析实验、调度 workflow、检查能力、维护状态机和生成报告；执行面负责启动 agent、注入故障、收集证据和恢复。

## 集成层级

`generic-cli`、`generic-desktop` 和代理层面向所有可启动的工具型 Agent；Codex、Claude、Kimi、ZCode 只是当前具名 adapter。工作区不一定是代码仓库，也可以是文档、浏览器 profile、数据目录或其它隔离执行目录。当前桌面层先提供真实 `desktop.close_window` / `desktop.send_text` 原语，完整 `generic-desktop` adapter 仍未实现。

### generic-cli

启动命令、隔离 cwd、stdin/PTY、进程树和退出码。适用于 Codex CLI、Claude Code CLI、Kimi CLI、ZCode CLI、OpenCode。

### generic-desktop

完整 adapter 尚未实现。已实现的 `desktop.close_window` 与 `desktop.send_text` 通过 Rust helper 在 macOS 调用 Accessibility/System Events，在 Windows 调用 UI Automation/SendKeys；renderer 状态、输入结果确认和无响应检测仍需要 `generic-desktop`。

### llm-proxy

Agent 到 LLM 的 OpenAI 兼容 HTTP 代理，以及 MCP HTTP JSON-RPC 代理：delay、timeout、429/5xx、partial stream、坏 JSON、重复 chunk、schema drift、MCP oversized。LLM 代理还支持字段级修改（`content` / `tool_calls`）、注入时间表（single / persistent / intermittent / burst / callIndex）以及 empty / corrupt / html / stale_* / wrong_entity / degrade。自动处理 OpenAI 与 Anthropic Messages 协议（`/v1/messages`，支持 SSE 流式）；MCP 同时支持 HTTP 代理与 stdio 包装器（`agentchaos-mcp-stdio.js`）。命中时写 `llm_fault_triggered` 事件。

### native-event adapter

从 agent stdout 的整行 JSON 分类 `approval_requested`、`tool_started`、`tool_finished`、`compaction_started`、`session_checkpoint`、`subagent_finished` 等，写入 JSONL，并支持 `faults[].when`。不是独立的事件订阅 API；不打 JSON 的 TUI 观测不到。

## 权限与 helper

CLI/文件/普通进程测试不需要特权。桌面测试需要 helper：Mac 负责 Accessibility、TCC、睡眠/唤醒和网络扩展；Windows 负责 UI Automation、Job Object、ConPTY、ACL/UAC 和网络过滤。控制面通过 IPC 调用 helper，helper 使用实验级授权、超时和审计日志。

## 目标接口

```python
class AgentTarget:
    start(config) -> RunHandle
    stop(handle)
    resume(session)
    send_input(input)
    cancel()
    snapshot() -> AgentSnapshot
```

```python
class FaultInjector:
    inject(spec) -> InjectionHandle
    recover(handle)
```

```python
class WorkspaceAdapter:
    snapshot()
    mutate(fault)
    git_state()
```

Adapter 启动时声明 capabilities，例如 `cli`、`desktop-ui`、`session-resume`、`mcp`、`tool-events`。控制面把能力分为 `supported`、`degraded`、`unsupported`：PTY 缺失可以降级为管道，进程树和 session-resume 等必需能力缺失则由 `validate`、`run`、`suite`、`workflow` 直接拒绝。

## 实验契约

```yaml
apiVersion: agentchaos.dev/v1alpha1
kind: Experiment
metadata:
  name: kill-and-resume
spec:
  target:
    adapter: generic-cli
    command: codex exec --full-auto "修复 bug 并运行测试"
  workload:
    fixture: repo-042
  faults:
    - type: process
      action: kill
      target: agent
      at: 30m
  recovery:
    restart: true
    resume: true
  assertions:
    - task_tests_pass
    - no_duplicate_side_effect
    - no_orphan_process
```

Workflow 当前支持串行、并行；失败默认即停，`failFast: false` 或 `--continue` 可继续。条件分支和定时调度尚未实现。

## 状态机

```text
Idle -> Planning -> AwaitingApproval -> ExecutingTool
     -> Streaming -> Compacting -> Recovering
     -> Completed / Failed / Cancelled
```

每次转换保存 event id、session revision、tool call id、进程树、workspace hash、Git 状态和 fault 状态。

## 故障类型

已实现：
- `process`：kill / pause / restart（支持主进程整树杀或挂起）
- `subagent`：kill / timeout / fail / conflict / checkpoint（支持定向子进程控制与检查点恢复）
- `session`：corrupt / truncate / lock / schema_drift（支持隔离目录真实会话文件破坏与表结构漂移）
- `desktop`：close_window / send_text / screenshot / freeze（原生窗口关闭、按键、真实屏幕截图证据与 UI 挂起）
- `remote`：disconnect / heartbeat_timeout / lease_expire（内置 `RemoteCoordinator` 协调器租约/心跳/断连模拟）
- `resource`：cpu / memory / port / disk（有界加压）以及 handle_exhaustion / disk_exhaustion（真实 EMFILE/ENOSPC 极限测试）
- `mcp`：429 / 500 / delay / timeout / malformed / oversized / crash / partial_write / chunked，支持 HTTP 代理与 Stdio 真实上游代理去重隔离
- `llm`：401 / 429 / 500 / malformed / truncate / schema_drift / duplicate / empty / corrupt / html / degrade / stale_cache / stale_data / wrong_entity，支持 `field`、`schedule`、`callIndex`，以及 OpenAI 与 Anthropic Messages 协议
- `file`：edit（支持 sizeBytes 大文件）/ delete / rename / chmod / lock
- `git`：lock / conflict / switch-branch / worktree-leak / worktree-lock
- `approval`：deny / drop / delay
- `compaction`：interrupt
- `input`：send / eof

尚未实现（见 [roadmap.md](./roadmap.md)）：桌面 renderer/webview 内部 crash 注入、macOS TCC 授权弹窗 / Windows UAC 交互向导、sleep/wake、显示器/DPI 变化、自动更新打断、完整 ACP host bridge、生产环境真实多机网络分区、无保护的系统级物理 OOM 宕机。

## 事件和证据

事件采用 append-only JSONL；每条记录包含 run_id、event_id、时间、状态、detail；native 事件可带 `toolCallId` / `sessionRevision`。实验结束输出结果、原始事件和环境信息。已支持真实桌面截图证据采集（PNG 文件保存至 run 证据目录并进行非空断言）。SQLite 跨 run 查询、深度 crash dump 解析仍在演进中。

## 断言与指标

省略 `assertions` 时，系统按本次实验补齐可观测检查项：超时、残留进程、重复工具调用、丢失的工具结果；启用 git 时增加 Git 锁与仓库检查；可恢复故障或 `mode: auto` 时检查恢复后是否仍有活动；YAML 中的每条故障增加 `fault_injected` 及对应专项（MCP / subagent / worktree / desktop / resource / remote）；配置了 `verify` / `expected` 或 `recovery.resume` + `ephemeral: false` 时增加任务测试、期望文件与会话可恢复。`mode: auto` 运行中新注入的故障会补齐 `fault_injected` / `llm_triggered`。判定仅依据上述实测结果。

断言包括：`task_tests_pass`、`exit_zero`、`exit_nonzero`、`not_timed_out`、`session_resumable`、`session_clean_recovery`、`no_duplicate_tool_side_effect`、`no_lost_tool_result`、`mcp_stdio_upstream_consistent`、`subagent_checkpoint_restored`、`desktop_screenshot_captured`、`desktop_unresponsive_detected`、`resource_exhaustion_recovered`、`remote_lease_valid`、`remote_reconnect_success`、`workspace_matches_expected`、`git_state_consistent`、`git_worktree_clean`、`no_orphan_process`、`application_eventually_responsive`、`event_seen`。

指标包括：`pass^k`、recovery rate、resume success、rework ratio、user takeover rate、orphan process rate、state divergence、lost tool results 和 MTTR。

## MVP 实现

TypeScript 控制面位于 `packages/runner`：解析 YAML/JSON、adapter、按 `at`/`duration` 调度故障、JSONL 事件、断言与 JSON/HTML 报告。用户入口为 npm 包 `agentchaos`；从本仓库运行时使用 `./agentchaos` 或 `.\agentchaos.cmd`。报告通过 `agentchaos view` 查看。

当前可测故障：`process.kill` / `process.pause` / `process.restart`、`file.edit|delete|rename|chmod|symlink|lock`（`edit` 可带 `sizeBytes`）、`git.lock|conflict|switch-branch`、`network.delay|timeout|reset`、`llm.401|429|500|malformed|truncate|schema_drift|duplicate|empty|corrupt|html|degrade|stale_*|wrong_entity`、`mcp.429|timeout|oversized|…`、`approval.deny|drop|delay`、`compaction.interrupt`、`resource.cpu|memory|port`、`input.send|eof`。进程树终止/暂停、文件锁、资源压力和 PTY/ConPTY 由 `agentchaos-helper` 执行。Windows 10+ 使用 Job Object 杀树、`SuspendThread` 暂停、`LockFileEx` 锁文件、ConPTY 跑 `target.pty`；未开 pty 时 CLI adapter 用管道采集 stdout/stderr。

控制面额外支持：Workload/ChaosProfile 组合、Suite pass^k、Workflow 串行/并行、`validate` 风险预览、`watch`/`replay`/`list`、隐藏 grader（`verify` + `task_tests_pass`）、prompt 语义扰动、逐步 `shadow_compare`（含 agent pending tools）、可恢复性指标（recovery / MTTR / resume / orphans / duplicate / takeover / divergence / lost tools）、`--dry-run`、`faults[].when`。

示例：协议套件 `examples/suites/protocol.yaml`；产品实验见 [scenarios.md](./scenarios.md)。入口和故障分开写，见 [examples/README.md](../examples/README.md)。

## 验证策略

协议确定性测试、故障注入、长时 endurance、property/model-based testing、trajectory replay 和 Mac/Windows 矩阵测试。长时测试以事件次数和 checkpoint 压缩时间，不把等待小时数当作通过依据。

## 安全边界

产品级「测什么 / 不测什么」见 [design.md](./design.md) 的边界。运行时：默认使用临时仓库和隔离账号；危险命令和真实用户目录需要显式 opt-in。helper 权限最小化，所有注入和恢复操作可审计；实验取消或超时必须恢复故障并清理子进程。

## 技术栈与构建

核心采用 TypeScript workspace：`runner`、`workflow`、`proxy`、`adapters`。Rust 只构建 `agentchaos-helper`，负责进程树、PTY/ConPTY、资源和平台 API。事件存储现为 JSONL；SQLite、Dashboard、WebSocket 实时 viewer 尚未实现。CLI 是主入口。

平台 bridge 采用最小化原则：Rust 负责生命周期、策略和审计；Swift/Objective-C 只封装 macOS Accessibility/TCC/Screen Recording/睡眠 API；Windows bridge 只封装 UI Automation、Job Object、ConPTY、ACL/UAC。每个 helper 以独立版本发布，控制面通过版本化 IPC 协议通信。

Python 保留给轨迹分析和离线报告，不作为生产 runner 的长期依赖。Rust helper 构建 macOS universal binary 和 Windows x64/arm64 binary；TypeScript runner 通过 npm/pnpm 发布，并在 CI 中执行跨平台 adapter contract tests。

## CLI 与 Dashboard 契约

```text
agentchaos run examples/zcode.yaml
                             默认实验：ZCode × 安装包全部故障类
agentchaos validate run.yaml 校验 schema、权限和前置能力
agentchaos run run.yaml      启动 Experiment / Suite / Workflow
agentchaos run run.yaml --repeat k
                             计算 pass^k
agentchaos view [--open]     本地评测报告（scores + trace）
agentchaos suite suite.yaml  批量实验
agentchaos workflow wf.yaml  串行 / 并行工作流
agentchaos watch <run-id>    查看实时事件时间线
agentchaos replay <run-id>   用保存的 experiment.json 再跑
agentchaos list              最近 run 索引
agentchaos report <run-id>   生成 JSON/HTML 报告
agentchaos recover <run-id>  执行遗留故障清理
```

Dashboard 只调用稳定的 runner API，不直接控制目标进程；所有控制动作都写入事件日志。这样 CLI、桌面 UI 和 CI 使用同一套语义，避免三套行为分叉。
