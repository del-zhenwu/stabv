# AgentChaos 功能缺口

本文档按依赖列出尚未具备的能力（adapter、故障、helper、评测），不含时间承诺。产品入口与包装形态见 [design.md](./design.md)。已具备能力仅作对照。

## 对照：当前已具备

- 本地 CLI + YAML/JSON 实验（`setup` / `run` / `validate` / `view` / `replay` / `recover`）
- TypeScript 控制面 + Rust `agentchaos-helper`（HelperWorker 集中生命周期管理、协议版本 1.1.0、进程树、pause/resume、flock、CPU/内存、Unix PTY / Windows ConPTY）
- 故障：`process`、`file`（含 `sizeBytes` 大写入）、`git`（lock/conflict/switch-branch/worktree-leak/worktree-lock）、`network` CONNECT 代理、`llm`（OpenAI 与 Anthropic Messages `/v1/messages` 兼容代理，含透明透传 MITM、字段级 content/tool_calls、single/persistent/intermittent/burst 时间表、empty/corrupt/html/stale_*/wrong_entity/degrade）
- 混沌模式与监控：`mode: rules`（只跑 YAML `faults`）与 `mode: auto`（`pi-agent-core` + observe/strike/stop，需 `AGENTCHAOS_LLM_API_KEY`）；`replay` 回放已记录故障；细粒度 I/O 停滞与重试风暴看门狗
- 资源与极限：`resource.cpu|memory|port|disk`（有界压力）以及真实隔离极限测试 `resource.handle_exhaustion`（真实句柄耗尽）、`resource.disk_exhaustion`（真实磁盘填满）
- MCP 协议与上游代理：HTTP JSON-RPC 代理与 stdio 代理包装器（支持 `--upstream` 上游工具隔离与幂等去重、`partial_write` 半写入、`chunked` 分块输出、超时/延迟/429/500/crash）
- 子 Agent 编排：真实进程树定位与 `subagent.kill|timeout|fail|conflict`，本地生命周期 journal、跨重启 generation 一致性与 `subagent.checkpoint` 检查点恢复断言
- 会话存储：隔离 `target.sessionHome` 中的真实文件损坏、截断、锁与 `session.schema_drift`（表结构漂移与版本冲突），以及 `session_clean_recovery` 校验
- 真实桌面桥：`desktop.close_window`、`desktop.send_text`、`desktop.screenshot`（真实 OS 屏幕证据截图保存）、`desktop.freeze`（真实 UI 挂起与响应性探测）
- 远程/云端生命周期：`RemoteCoordinator` 本地云端协调器，租约申请（Lease TTL）、心跳保持、远端检查点，以及 `remote.disconnect|heartbeat_timeout|lease_expire` 故障注入
- Workload / ChaosProfile 组合、Suite `pass^k`、Workflow 串行/并行
- 隐藏 grader、prompt 语义扰动、能力/风险预览
- 评测报告（scores + trace + 证据截图）、本地 viewer（按 Suite/Workflow 任务聚合，首页自动刷新）；可恢复性指标（recovery / MTTR / restarts / resume 会话连续性 / orphans / duplicate tools / state diverge / user takeover）
- `validate` 深度校验：Suite / Workflow 逐个校验引用的实验文件，Workload / ChaosProfile 结构校验，错误带文件路径；`report` 默认输出人读摘要（`--json` 保留原始 JSON）
- 逐步 `shadow_compare`：harness 已注入列表、workspace hash、git lock、进程是否存活、pending tools、last native、session id
- Windows 10+：Job Object、`SuspendThread`、`LockFileEx`、只读属性
- Harbor-style 声明式 `AgentDescriptor` 体系与标准 PATH / 环境变量优先发现（清理调度器内部的私有目录硬编码）；Codex、ZCode、Claude、Kimi 均支持强类型参数生成与 session resume
- 强类型 Tagged Union 原生事件分类（零模糊正则，杜绝消息聊天文本关键词导致的假阳性）
- 认知级规则与上下文混沌：`rule.conflict`、`rule.evict`、`rule.corrupt`、`context.poison`、`context.truncate`
- `mode: auto`：运行中由 LLM planner 选故障（observe / strike / stop），`replay <run-id>` 按记录回放

CLI 实验默认用管道采集 stdout/stderr。`target.pty: true` 时走 helper `pty-spawn`（Unix PTY / Windows ConPTY）；缺能力则降级为管道。

## 明确未支持的能力

下面的能力已经从主流 Agent 的缺陷和发布记录中确认是高价值测试面，但当前版本**不能声称支持**。它们不是“配置一个 YAML 就能运行”的隐藏选项；在能力发现中应返回 `unsupported`，而不是静默降级为看似成功的实验。对应的证据和产品覆盖矩阵见 [product-reliability-matrix.md](./product-reliability-matrix.md)。

### 桌面与操作系统

- sleep/wake、显示器插拔/动态多显示器 DPI 切换、锁屏/解锁打断。
- 操作系统级交互式权限向导（macOS TCC 权限申请/撤销弹窗自动化点击、Windows UAC 提权凭据对话框自动化交互与提权后句柄迁移）。
- 现已支持：原生窗口关闭、文本发送、真实屏幕截图证据捕获（`desktop.screenshot`）、UI 线程冻结（`desktop.freeze`）与响应性探测。

### Agent 协议与编排

- 完整 ACP host bridge（包含与 Zed/JetBrains 等宿主编辑器的双向能力协商与插件协议转换）；当前通过黑盒 CLI、stdout JSON 事件分类及 MCP stdio/HTTP 代理进行测试。
- 模型内部压缩轨迹的逐步语义重放与 Fuzzing；当前支持 compaction 中断、事件驱动注入与 shadow 状态对比。
- 现已支持：MCP stdio/HTTP 协议故障注入、上游工具调用副作用去重隔离、`partial_write` 半写入断裂、子 agent checkpoint 恢复断言。

### 远程与托管 Agent

- 跨物理机器的分布式多节点集群协调与真实跨地域专线物理切断；当前通过内置 `RemoteCoordinator` 提供单节点云端 Agent 生命周期、租约 TTL 漂移、心跳超时与重连恢复实验。

### 存储与资源极限

- 真实 Agent 生产级跨大版本数据库自动升级/迁移器（Migration Engine）；桌面 transcript 达到数十 GB 级别的无保护系统级 OOM。
- 现已支持：工作区内隔离文件句柄耗尽测试（`resource.handle_exhaustion`）、隔离磁盘配额填满测试（`resource.disk_exhaustion`）、受保护的内存加压与 `session.schema_drift`。

这些限制也解释了为什么“长时间跑一个复杂评测题”不是充分的覆盖方案：它可能碰巧触发问题，但无法证明注入点、恢复路径或 exactly-once 不变量被稳定验证。

分层实现审计和逐步改造方案见 [architecture-audit.md](./architecture-audit.md)。

---

## 0. 代码评审改进项（2026-09 本轮）

对照最初目标（大概率发现稳定性缺陷 + 用户好用）做的一次全量代码评审。已修复的不再列为待办；其余进入对应章节。

**已修复（本轮落地）**

- `--dry-run`：展开 Experiment / Suite / Workflow，打印命令、故障、恢复与风险，不启动 agent。
- YAML 故障解析错误带 `file:line`。
- Workflow `failFast: false` / CLI `--continue`：失败后继续跑剩余步骤。
- 报告 HTML 长 trace 只保留最后 250 条。
- helper `pty-spawn`：Unix PTY 与 Windows ConPTY；`input.send` / `input.eof` 按时间写入 stdin。
- Native event 分类：从 stdout JSON 识别 `tool_started` / `tool_finished` / `approval_requested` / `compaction_*` / `session_checkpoint` / `subagent_*`，并支持 `faults[].when` 按事件注入。
- MCP HTTP JSON-RPC 代理：`mcp.delay|timeout|429|500|malformed|truncate|schema_drift|duplicate|oversized`。
- `approval.deny|drop|delay`、`compaction.interrupt`；报告恢复 `lostToolResults`；断言 `event_seen` / `no_lost_tool_result`。
- Claude / Kimi 完整 CLI adapter（`--print`、JSON、审批绕过、`--resume`）。

- `resumeSuccess` 不再把「进程重启过」当成「session 恢复成功」：resume 会核对恢复后 agent 重新上报的 session id 是否一致，不一致记为 fail（语义分叉的直接信号）；无法观测时保持未定义，纯 restart 计入新的 `restarts` 指标。
- `mttrMs` 改为全部 fault→recover 对的均值（原来只取第一对，多故障实验数值错误）。
- 报告移除永远为空的 `lostToolResults`（依赖尚不存在的 native tool 事件，见第 4 节，不伪造）。
- `application_eventually_responsive` 不再等价于 `not_timed_out`：有可恢复故障在运行中恢复时，要求「恢复后 agent 仍有输出或干净退出」——「故障恢复后静默死亡」现在会被抓住。
- `recovery.resume: true` 单独出现时也触发 kill 后的恢复循环（原来漏写 `restart: true` 会静默不恢复）。
- `validate` 真正校验 Suite / Workflow 引用的每个实验文件与 Workload / ChaosProfile 结构（原来一律 `ok: true`）；YAML / 语义错误带文件路径。
- Suite 在跑任何 trial 之前先完成全部实验的加载与校验；两个实验共用 `metadata.name` 时报错而不是静默合并 pass^k。
- CLI 未知 flag 直接报错并列出合法 flag（原来静默忽略，`--dr-run` 这类手误等于白跑）；`list` 容忍损坏的 index 行；`report` 默认输出人读摘要。
- viewer 首页按 Suite / Workflow 任务聚合（case 嵌套），并自动刷新（轮询 `/api/runs`）；`/runs/<id>` 路径穿越修复；suite / workflow 报告里的 run 链接改为相对路径，`file://` 打开不再失效。

**评审新列入的待办**

- 断言错误在更多路径上带 YAML 列号（故障解析已有 `file:line`）。
- CLI 层（parseFlags / list / report / view）纳入常规回归测试（本轮已补一部分）。

---

## 1. Agent 接入

当前黑盒主要验证了 Codex CLI、ZCode CLI、Claude / Kimi 的 argv 契约，以及 `generic-cli` 替身。

- **Claude / Kimi 本机产品实验**：adapter 已拼真实参数；还需要在已安装 CLI 的机器上跑 `--workload examples/workloads/claude.yaml` / `kimi.yaml` 配 `profiles/process/kill.yaml`（控制面不登录模型）。
- **OpenCode、Cursor CLI、Zed/ACP**：设计范围里的其余 harness，统一走 `generic-cli` 或独立 adapter。
- **桌面客户端 adapter（`generic-desktop`）**：ChatGPT/Codex 桌面、Claude Desktop 等；控制窗口、发输入、检测无响应。依赖第 6 节平台 helper。
- **能力发现加深**：版本、平台、`cli` / `desktop-ui` / `session-resume` / `mcp` / `tool-events`，`unsupported` / `degraded` 覆盖到 adapter 级而不只是 helper 命令。

## 2. 终端、会话与输入

- **按事件注入输入**：`faults[].when` 已能在 `tool_started` / `approval_requested` / `compaction_started` 等事件后注入；取消与完成竞态仍缺显式 `cancel` 故障。
- **真正的 session resume**：Codex `exec resume`、Claude/Kimi `--resume`、ZCode `--resume` 已接线；各家 session 文件与 `session_resumable` 的隔离副本仍不完整。
- **轨迹级 replay 与 fuzzing**：按事件日志重放 tool/输出时间线，并随机打乱返回顺序、插话时刻、审批耗时、延迟、压缩触发点。现有 `replay` 是「用保存的 YAML 再跑一遍」，不是轨迹重放。

## 3. 故障类型补齐

已有种类不再列出。下列来自设计/技术文档，YAML 里还没有可用实现。

**LLM / 协议**

- Anthropic Messages 协议：已支持（自动兼容 OpenAI 与 `/v1/messages` SSE 流式，支持 401/429/500/malformed/truncate/schema_drift/duplicate/empty/corrupt 及字段级时间表）
- 上下文压缩后的状态漂移（现有 `compaction.interrupt` 只杀进程，不做压缩后语义漂移）

**工具与编排**

- MCP stdio / 子 agent 故障：MCP 单进程 journal/exactly-once、跨进程 request replay 与真实 subagent 生命周期 journal 已支持；`subagent.kill` / `timeout` / `conflict` 仍用于真实进程树故障；本地跨重启 parent/child 关联已有 journal/断言，checkpoint 和远程恢复仍缺
- 审批弹窗关闭（桌面）；CLI 侧 `approval.deny|drop|delay` 已可用
- Agent hooks 注入失败或被外部改写

**Workspace / Git / 资源**

- Git worktree 残留：已支持（`git.worktree-leak` / `git.worktree-lock` + 断言 `git_worktree_clean`）
- 有界磁盘压力与隔离极限：已支持（`resource.disk`、`resource.disk_exhaustion`、`resource.handle_exhaustion`）；宿主机级物理耗尽、巨量 stdout（超长流式输出）仍缺
- session 存储：已支持对隔离 `target.sessionHome` 中的真实文件做损坏、截断和锁；禁止打真实用户主目录；migration/recovery 仍缺
- 更完整的 Windows ACL（现 `chmod` 只映射只读属性）
- 只杀某个子进程、不杀整树：已支持（helper `kill-process` / `subagent.kill`）

**桌面 / OS**（依赖 helper）

- sleep / wake
- renderer crash、输入丢失；窗口关闭和 native text input 已支持 helper（跨平台权限和真实桌面 target 仍需矩阵验证）
- 自动更新打断
- 系统权限对话框（TCC / UAC）

## 4. 事件、断言与证据

- **Native event adapter**：已从 stdout JSON 分类 `approval_requested`、`tool_started`/`finished`、`compaction_started`、`session_checkpoint`、`subagent_finished`。不是独立订阅 API；agent 不打 JSON 就观测不到。完整影子执行（agent 认为的状态的逐步语义）仍缺。
- **事件字段补齐**：JSONL 现可带 `toolCallId`、`sessionRevision`；进程树快照、UI 状态仍不完整。
- **证据**：脱敏终端日志、截图、crash dump；报告里可点开。
- **指标**：丢失 tool 结果数已按 `tool_started` vs `tool_finished` 统计。丢失消息数仍缺。recovery / resume / orphans / duplicate / takeover / divergence 已在报告里。
- **SQLite 事件存储**：跨 run 查询与比较；当前仍为 JSONL + `index.jsonl`。

## 5. 编排与评测

- **Workflow 条件分支与定时调度**（Chaos Mesh 完整模型）。现仅 serial / parallel，失败即停。
- **矩阵对比**：同一 workload 下多 agent / 多 profile 并排比较。
- **Viewer 实时时间线**：WebSocket 推送 running 实验；键盘浏览 job。现 `view` 读已结束的 HTML。
- **长时 endurance runner**：按事件次数压缩时间（工具调用、上下文压缩、断连、重启、睡眠唤醒、并发 subagent），用 checkpoint 而不是墙钟小时当通过条件。
- **Property / model-based 测试**：状态机不变量（无孤儿进程、故障必恢复、workspace 不逃逸）。
- **完整影子执行**：每步比较 agent 视图 / harness 视图 / 文件系统与 Git；现在 `shadow_compare` 含 harness 已注入、workspace/git/process，以及 agent 侧 pending tools / last native / session id。还不是逐步语义对齐。
- **JSON Schema 公开发布**：`agentchaos.dev/v1alpha1` 可被编辑器和 CI 校验。

## 6. 平台 Helper

控制面不承载这些能力；全部经版本化 IPC。

**共用**

- Helper 实验级授权、超时、审计日志
- 版本化 IPC；macOS universal 与 Windows x64/arm64 独立发布

**macOS**

- Accessibility / TCC / Screen Recording
- 睡眠唤醒
- 网络扩展（真·断网，而不是只靠 `HTTP(S)_PROXY`）
- 权限向导：用途、范围、撤销；拒绝时降级为 CLI/文件/网络实验

**Windows**

- UI Automation
- UAC / ACL 向导
- 网络过滤

---

## 7. 对照 40 个高价值场景

逐条「能 / 不能 / 怎么跑」写在 [scenarios.md](./scenarios.md)。这里只列**仍缺、且应该做**的：

还不能打、已在上面分节里：超长流式输出（缺巨量 stdout 注入）、取消竞态、审批弹窗关窗、OAuth、压缩后状态漂移、乱码、MCP hook、真 IDE 风暴、睡眠唤醒、自动更新、TCC 自动化向导。

明确不做（伪造杀软等）见 [design.md](./design.md) 的边界，不要当作路线图条目。

时间压缩、轨迹 fuzzing、完整三方影子执行见第 2 / 4 / 5 节，不要靠堆 YAML 冒充。

---

## 建议实现顺序（无日期）

只表达依赖，方便排期讨论：

1. 其余 CLI adapter（OpenCode / Cursor CLI / Zed/ACP；Claude / Kimi argv 已接入）。
2. 取消竞态、压缩后漂移（PTY、native events、MCP HTTP/stdio 代理与上游副作用去重、Anthropic Messages、审批/压缩中断、subagent checkpoint 故障已接入）。
3. 句柄耗尽、真实磁盘填满、桌面证据截图/UI冻结、远程协调器租约生命周期（已接入真实原语与断言）。
4. Helper 版本化发布（1.1.0 已落地）+ 深度桌面 bridge（sleep/wake、显示器插拔）。
5. endurance runner、实时 viewer；若要做 Dashboard / CI Action / npm，按 [design.md](./design.md) 的产品形态，共用 runner API，且不取代 CLI 主入口。
