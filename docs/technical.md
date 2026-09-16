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

### generic-cli

启动命令、隔离 cwd、stdin/PTY、进程树和退出码。适用于 Codex CLI、Claude Code CLI、Kimi CLI、ZCode CLI、OpenCode。

### generic-desktop

使用 macOS Accessibility/Screen Recording 或 Windows UI Automation 控制窗口、发送输入、检测 renderer 和无响应，并收集截图与崩溃报告。

### llm-proxy

Agent 到 LLM/MCP 的 HTTP(S) 代理，注入 delay、timeout、429/5xx、partial stream、坏 JSON、重复 chunk、schema drift。优先支持 OpenAI-compatible 和 Anthropic 协议。

### native-event adapter

可选接收 `task_started`、`approval_requested`、`tool_started`、`tool_finished`、`compaction_started`、`session_checkpoint`、`subagent_finished` 等事件。

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

Adapter 启动时声明 capabilities，例如 `cli`、`desktop-ui`、`session-resume`、`mcp`、`tool-events`。

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

Workflow 支持串行、并行、条件分支和定时调度，借鉴 Chaos Mesh Workflow。

## 状态机

```text
Idle -> Planning -> AwaitingApproval -> ExecutingTool
     -> Streaming -> Compacting -> Recovering
     -> Completed / Failed / Cancelled
```

每次转换保存 event id、session revision、tool call id、进程树、workspace hash、Git 状态和 fault 状态。

## 故障类型

- `llm`: timeout、429、partial stream、malformed JSON、schema drift。
- `process`: kill、pause、restart、孤儿进程。
- `file`: 外部编辑、删除、重命名、权限、锁、符号链接。
- `git`: lock、冲突、分支切换、worktree 残留。
- `resource`: CPU、内存、磁盘、句柄、巨量输出。
- `desktop`: sleep/wake、窗口关闭、renderer crash、输入事件丢失。

## 事件和证据

事件采用 append-only JSONL；每条记录包含 run_id、event_id、时间、状态、fault、toolCallId、session revision、workspace/Git hash、进程树和 UI 状态。实验结束输出结果、原始事件、脱敏日志、截图、crash dump 和环境信息。

## 断言与指标

断言包括 `task_tests_pass`、`session_resumable`、`no_duplicate_tool_side_effect`、`workspace_matches_expected`、`git_state_consistent`、`no_orphan_process`、`application_eventually_responsive`。

指标包括 `pass^k`、recovery rate、resume success、rework ratio、user takeover rate、orphan process rate、state divergence 和 MTTR。

## MVP 实现

TypeScript control plane 位于 `packages/runner`：解析 YAML/JSON 实验、Codex/generic-cli adapter、按 `at`/`duration` 调度故障、JSONL 事件、断言和 JSON/HTML 报告。CLI 为根目录 `./agentchaos` / `.\agentchaos.cmd`（也可 `npx agentchaos run <spec>`），报告为 `agentchaos view`。

当前可测故障：`process.kill` / `process.pause` / `process.restart`、`file.edit|delete|rename|chmod|symlink|lock`（`edit` 可带 `sizeBytes`）、`git.lock|conflict|switch-branch`、`network.delay|timeout|reset`、`llm.401|429|500|malformed|truncate|schema_drift|duplicate`、`resource.cpu|memory|port`、`input.send|eof`。进程树终止/暂停、文件锁、资源压力和 PTY/ConPTY 由 `agentchaos-helper` 执行。Windows 10+ 使用 Job Object 杀树、`SuspendThread` 暂停、`LockFileEx` 锁文件、ConPTY 跑 `target.pty`；未开 pty 时 CLI adapter 用管道采集 stdout/stderr。

控制面额外支持：Workload/ChaosProfile 组合、Suite pass^k、Workflow 串行/并行、`validate` 风险预览、`watch`/`replay`/`list`、隐藏 grader（`verify` + `task_tests_pass`）、prompt 语义扰动、逐步 `shadow_compare`、可恢复性指标（recovery / MTTR / resume / orphans / duplicate / takeover / divergence）。

示例：协议套件 `examples/suite-protocol.yaml`；产品实验见 [scenarios.md](./scenarios.md)。

## 验证策略

协议确定性测试、故障注入、长时 endurance、property/model-based testing、trajectory replay 和 Mac/Windows 矩阵测试。长时测试以事件次数和 checkpoint 压缩时间，不把等待小时数当作通过依据。

## 安全边界

产品级「测什么 / 不测什么」见 [design.md](./design.md) 的边界。运行时：默认使用临时仓库和隔离账号；危险命令和真实用户目录需要显式 opt-in。helper 权限最小化，所有注入和恢复操作可审计；实验取消或超时必须恢复故障并清理子进程。

## 技术栈与构建

核心采用 TypeScript workspace：`runner`、`workflow`、`proxy`、`adapters`、`event-store` 和 `dashboard`。Rust 只构建 `agentchaos-helper`，负责进程树、PTY/ConPTY、资源和平台 API。TypeScript 使用 YAML/JSON schema、SQLite、JSONL 和 HTTP/WebSocket；CLI 与 Dashboard 共用 runner API。

平台 bridge 采用最小化原则：Rust 负责生命周期、策略和审计；Swift/Objective-C 只封装 macOS Accessibility/TCC/Screen Recording/睡眠 API；Windows bridge 只封装 UI Automation、Job Object、ConPTY、ACL/UAC。每个 helper 以独立版本发布，控制面通过版本化 IPC 协议通信。

Python 保留给轨迹分析和离线报告，不作为生产 runner 的长期依赖。Rust helper 构建 macOS universal binary 和 Windows x64/arm64 binary；TypeScript runner 通过 npm/pnpm 发布，并在 CI 中执行跨平台 adapter contract tests。

## CLI 与 Dashboard 契约

```text
agentchaos setup             编译 helper 并发现 agent
agentchaos init              发现 agent 并生成 capability 文件
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
