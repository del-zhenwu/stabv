# AgentChaos 分层实现审计

审计日期：2026-09-16。目标是检查当前代码和文档是否遵守产品约定的两层架构，并把“不支持”与“待实现”分开。

## 结论

当前实现总体遵守分层：TypeScript 是控制面，Rust helper 承担跨平台 OS 原语；CLI 是主要入口，桌面 bridge 尚未被伪装成已实现能力。现阶段不需要把 YAML、adapter 或报告逻辑迁移到 Rust。

需要修正的是能力边界和少量职责表述：文档曾把 Rust 写成“核心执行器”，容易让人误解为 Rust 应该编排实验；有界资源压力被部分文字简称为“磁盘压力”，容易被误读成真实磁盘耗尽；桌面、远程和 exactly-once 协议能力虽然列在长期方向中，但缺少统一的 `unsupported` 状态说明。当前已补上 runner/validate 的强制能力检查：缺少必需 helper 原语或 session-resume 时会阻止运行，PTY 缺失仍明确标记为 `degraded`。

## 代码与文档对照

| 责任 | 当前实现 | 判断 |
| --- | --- | --- |
| YAML/JSON、schema、workflow、调度、断言、报告 | `packages/runner` | 符合控制面职责 |
| Agent argv、CLI session resume、generic-cli | `packages/runner/src/adapters.ts` | 符合；不应移入 helper |
| HTTP LLM/MCP proxy、stdout native event 分类 | `packages/runner/src/proxy.ts`、事件模块 | 符合黑盒/协议代理定位；不是完整 ACP 或 exactly-once 引擎 |
| 进程树、pause/resume、PTY/ConPTY、锁和资源 worker | `helper/src`、`packages/runner/src/helper.ts` | 符合；Rust helper 不解析 YAML，也不构造 Codex argv |
| 目标 agent 的 kill/restart | runner 通过 `HelperClient.killTree` 等 IPC | 符合；TypeScript 没有直接按 PID 杀目标树 |
| helper worker 的最终清理 | `HelperClient.stopWorker`，由 `faults.ts` / `runner.ts` 调用 | 已收回 helper 边界；只清理 runner 自己启动的短生命周期 worker，不处理目标 agent 树 |
| 桌面 UI、TCC/UAC、远程生命周期 | 尚无实现 | 必须保持 `unsupported`，不能由 CLI 降级冒充 |
| 原生窗口关闭/文本输入/截图/冻结 | `helper/src/desktop.rs`：macOS Accessibility/System Events/screencapture、Windows UI Automation/System.Drawing | 已实现真实 OS 调用；支持原生窗口关闭、文本发送、真实屏幕截图证据捕获（`desktop.screenshot`）与 UI 冻结（`desktop.freeze`）；权限、窗口不存在或平台不支持时返回错误 |
| 远程生命周期协调器 | `packages/runner/src/remote.ts` | 已实现本地 `RemoteCoordinator`，支持租约 TTL、心跳、检查点与断连/心跳超时故障注入 |
| 极限资源测试 | `helper/src/resource.rs` | 已实现真实句柄耗尽（`resource.handle_exhaustion`）与工作区隔离磁盘填满（`resource.disk_exhaustion`） |
| 事件持久化 | JSONL + `index.jsonl` | MVP 可用；SQLite、跨 run 查询和完整 shadow execution 仍按计划推进 |

## 必须修正的文档问题

1. `docs/design.md` 的技术选型应说“TypeScript control plane/runner + Rust platform helper”，不能说 Rust 是实验的核心执行器。
2. `docs/roadmap.md` 需要明确区分有界 `resource.disk|memory` 与真实 ENOSPC/EMFILE/宿主机 memory pressure。
3. 桌面 renderer/TCC/UAC、ACP host、MCP 半写入/上游副作用 exactly-once、subagent checkpoint/远程恢复、远程/cloud、session migration/transcript OOM、sleep/display/update 等能力必须统一标为 `unsupported`，而不是和普通待办混在一起。
4. `docs/technical.md` 的故障清单应与 roadmap 同步，注明 MCP stdio/subagent 是局部注入能力，不代表完整 exactly-once 或状态恢复已完成。

## 改造方案

### 阶段 A：能力契约和边界（已开始）

- 为 adapter/helper 返回统一能力状态：`supported`、`degraded`、`unsupported`；`validate`、`run`、`suite`、`workflow` 已在实验依赖未支持能力时失败并保留原因。
- 增加 control-plane/helper contract test：检查 helper 不接受 YAML/argv 编排职责，runner 不直接实现进程树语义。
- 将有界资源故障命名为 bounded stress；真实宿主机极限实验必须使用隔离磁盘、句柄配额或专用虚拟机，并单独建 capability。

### 阶段 B：收紧 helper 生命周期边界（已落地）

- 增加了带 PID、平台类型和清理句柄的 `HelperWorker` 接口，把 `faults.ts` 与 `runner.ts` 中 helper worker 的管理与终止逻辑统一收回到 `HelperClient`（`stopWorker` / `stopAllWorkers`）。
- 为 helper IPC 增加了协议版本（`protocol_version: "1.1.0"`）、能力版本（`capabilities`）和审计字段；版本与能力严格核对，不静默降级。
- 完整保留 `killTree`、`pauseTree`、PTY/ConPTY 和平台 API 在 Rust helper，未将 OS 原语复制到 TypeScript。

### 阶段 C：协议与会话模型（已落地）

- MCP stdio 支持真实 upstream 代理（`--upstream`）与 live stream 拦截；引入 `inflight` 拦截与持久缓存，实现了上游工具调用副作用隔离与幂等去重（`mcp_stdio_upstream_consistent` 断言）；支持 `partial_write` 半写入断裂与 `chunked` 分块输出注入。
- subagent 支持 parent/child 检查点创建（`subagent.checkpoint`），并在子 agent 被杀/超时时校验检查点状态与工作区恢复（`subagent_checkpoint_restored` 断言）。
- 会话存储增加 `session.schema_drift` 表结构漂移/版本冲突故障注入，并提供 `session_clean_recovery` 恢复校验。

### 阶段 D：桌面 bridge（基础与证据已落地）

- 增加了真实操作系统级截图证据采集（`desktop.screenshot` 原生调用 macOS `screencapture` 与 Windows `CopyFromScreen` 保存 PNG 文件至 run 证据目录，断言 `desktop_screenshot_captured`）。
- 增加了真实 UI 进程冻结（`desktop.freeze`）与响应性探测（`desktop_unresponsive_detected`）。
- 剩余边界：跨显示器 DPI 切换、sleep/wake、TCC/UAC 交互向导与权限被拒后的交互向导。

### 阶段 E：远程与资源极限（单机协议与隔离极限已落地）

- 实现了本地云端协调器 `RemoteCoordinator`，支持租约申请（Lease TTL）、心跳保持、远端检查点同步以及 `remote.disconnect`、`remote.heartbeat_timeout`、`remote.lease_expire` 故障注入，断言 `remote_lease_valid` 与 `remote_reconnect_success`。
- 实现了工作区内真实极限压力测试：句柄耗尽测试（`resource.handle_exhaustion`）、隔离磁盘填满测试（`resource.disk_exhaustion`），以及加压恢复后的工作区可写探测断言 `resource_exhaustion_recovered`。
- 剩余边界：跨物理网络分区的分布式多机器集群、无保护的系统级物理 OOM 宕机（宿主机仍受健康守卫保护）。

### 阶段 F：自主混沌设计、证据来源分离与双向诊断协议（已落地）

- **`mode: auto`**：运行中由 LLM planner（observe / strike / stop）选故障；`replay` 按报告里记下的序列回放。旧的 `nemesis:` PRNG 路径已删除。
- **细粒度 I/O 停滞监控（Watchdog）**：在进程保持存活但遭遇网络死锁或死循环重试时，通过 I/O 静默阈值判定挂起，杜绝 harness 被动长时傻等。
- **证据来源（Evidence Provenance）严格分离**：
  - 工具核心严禁内置反编译逆向；逆向探针规范化为独立的 Coding Agent Skill（`.cursor/skills/agentchaos-adapter-probe/SKILL.md`）；
  - 报告中明确标注 `[EMPIRICAL]`（实测物理事实）与 `[STATIC_PROBE]`（静态逆向推测），禁止将未实测的推断作为实验结论。
- **双向诊断体系**：
  - 面向人类：增强 Web Dashboard，包含多轨甘特时序图、系统原生截屏证据画廊、`mode: auto` 决策轨道与证据来源徽章；
  - 面向 Coding Agent：输出结构化 `report.diagnosis.json`，提供因果链路、稳态不变量违反情况（如 `UNBOUNDED_RETRY_OR_DEADLOCK`）、复现命令与建议代码修复模式。

### 阶段 G：透明透传代理、重试风暴看门狗与 CLI 确定性重放（已落地）

- **LLM Proxy 真实上游透传（Transparent MITM Mode）**：`LlmProxy` 支持在无故障期透明代理真实大模型流量（`AGENTCHAOS_LLM_UPSTREAM` 或特定 Agent 自动探测），在故障期原地拦截注入，实现端到端业务任务与混沌恢复的结合。
- **重试风暴识别（Retry Storm Watchdog）**：在密集高频打印网络报错或重试日志时触发 `watchdog_retry_storm`，并自动生成 `RETRY_STORM_DEADLOCK` 不变量破坏诊断。
- **CLI 确定性重放（Deterministic Replay）**：`agentchaos replay <run-id>` 从 `mode: auto`（以及旧报告里的）决策记录取出时序与参数，固化为固定故障序列再跑。

### 阶段 H：现代适配体系（Harbor 模式）、强类型事件与认知级对抗（已落地）

- **现代化三层适配体系（Harbor-Style AgentDescriptor）**：彻底清理主干调度器中对桌面应用私有内部 bundle 目录（如 `/Applications/*.app/Contents/Resources/...`）的硬编码猜测；建立标准声明式 `AgentDescriptor` 注册表，遵循 `spec.target.executable` > 环境变量（`ZCODE_BIN` / `CODEX_BIN` 等） > 系统标准 `PATH` > 用户级包管理器全局 bin 的可靠解析优先级。
- **强类型 Tagged Union 原生事件匹配**：彻底废弃基于 `hay` 字符串拼接和全局模糊正则匹配事件的做法；按协议（Codex item、Claude tool_use、Anthropic SSE、Control types）实现完全强类型的 Tagged Union 解析，100% 杜绝 Agent 消息文本或 Prompt 包含关键字引发的假阳性误判。
- **规则与上下文认知混沌（Rule & Context Chaos）**：`LlmProxy` 原生支持在请求层动态注入 `rule.conflict`（冲突指令注入）、`rule.evict`（系统规则剔除/记忆遗忘测试）、`rule.corrupt`（语义反转）以及 `context.poison`（历史上下文毒化伪造工具输出）与 `context.truncate`。这些是故障种类，由 YAML 或 `mode: auto` 注入，记录写进 `autoDecisions`。

## 验收规则

- 任何未实现能力都必须在 `validate`、报告和文档中显示 `unsupported` 或 `degraded`，不得因为命令退出码为 0 而误报通过。
- 新故障先落 YAML 示例和断言，再增加 helper 原语，最后才改 runner；这保持控制面和执行面的依赖方向。
- 每次跨平台能力都要同时验证 macOS 与 Windows 10+ 的 capability 输出、恢复路径和证据字段。
