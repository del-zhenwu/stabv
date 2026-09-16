# AgentChaos 功能 Roadmap

不含时间承诺。只列**能力缺口**（adapter、故障、helper、评测），按依赖分组。产品入口、Dashboard、CI/npm 包装和「明确不做」写在 [design.md](./design.md)，这里不维护第二份清单。已上线的能力只作对照，避免把「待做」写成「已支持」。

## 对照：当前已具备

- 本地 CLI + YAML/JSON 实验（`setup` / `run` / `validate` / `view` / `replay` / `recover`）
- TypeScript 控制面 + Rust `agentchaos-helper`（进程树、pause/resume、flock、CPU/内存、Unix PTY / Windows ConPTY）
- 故障：`process`、`file`（含 `sizeBytes` 大写入）、`git`（lock/conflict/switch-branch）、`network` CONNECT 代理、`llm` OpenAI 兼容代理（含 `401` / truncate / duplicate）、`resource.cpu|memory|port`
- Workload / ChaosProfile 组合、Suite `pass^k`、Workflow 串行/并行
- 隐藏 grader、prompt 语义扰动、能力/风险预览
- 评测报告（scores + trace）、本地 viewer（首页自动刷新）；可恢复性指标（recovery / MTTR / restarts / resume 会话连续性 / orphans / duplicate tools / state diverge / user takeover）
- `validate` 深度校验：Suite / Workflow 逐个校验引用的实验文件，Workload / ChaosProfile 结构校验，错误带文件路径；`report` 默认输出人读摘要（`--json` 保留原始 JSON）
- 逐步 `shadow_compare`：harness 已注入列表、workspace hash、git lock、进程是否存活
- Windows 10+：Job Object、`SuspendThread`、`LockFileEx`、只读属性
- Codex `exec --json` adapter；ZCode `--prompt --json` adapter（含 App 内 `zcode.cjs` 发现）；Claude / Kimi 仅为按 PATH 发现的薄封装

CLI 实验默认用管道采集 stdout/stderr。`target.pty: true` 时走 helper `pty-spawn`（Unix PTY / Windows ConPTY）；缺能力则降级为管道。

---

## 0. 代码评审改进项（2026-09 本轮）

对照最初目标（大概率发现稳定性缺陷 + 用户好用）做的一次全量代码评审。已修复的不再列为待办；其余进入对应章节。

**已修复（本轮落地）**

- `--dry-run`：展开 Experiment / Suite / Workflow，打印命令、故障、恢复与风险，不启动 agent。
- YAML 故障解析错误带 `file:line`。
- Workflow `failFast: false` / CLI `--continue`：失败后继续跑剩余步骤。
- 报告 HTML 长 trace 只保留最后 250 条。
- helper `pty-spawn`：Unix PTY 与 Windows ConPTY；`input.send` / `input.eof` 按时间写入 stdin。

- `resumeSuccess` 不再把「进程重启过」当成「session 恢复成功」：resume 会核对恢复后 agent 重新上报的 session id 是否一致，不一致记为 fail（语义分叉的直接信号）；无法观测时保持未定义，纯 restart 计入新的 `restarts` 指标。
- `mttrMs` 改为全部 fault→recover 对的均值（原来只取第一对，多故障实验数值错误）。
- 报告移除永远为空的 `lostToolResults`（依赖尚不存在的 native tool 事件，见第 4 节，不伪造）。
- `application_eventually_responsive` 不再等价于 `not_timed_out`：有可恢复故障在运行中恢复时，要求「恢复后 agent 仍有输出或干净退出」——「故障恢复后静默死亡」现在会被抓住。
- `recovery.resume: true` 单独出现时也触发 kill 后的恢复循环（原来漏写 `restart: true` 会静默不恢复）。
- `validate` 真正校验 Suite / Workflow 引用的每个实验文件与 Workload / ChaosProfile 结构（原来一律 `ok: true`）；YAML / 语义错误带文件路径。
- Suite 在跑任何 trial 之前先完成全部实验的加载与校验；两个实验共用 `metadata.name` 时报错而不是静默合并 pass^k。
- CLI 未知 flag 直接报错并列出合法 flag（原来静默忽略，`--dr-run` 这类手误等于白跑）；`list` 容忍损坏的 index 行；`report` 默认输出人读摘要。
- viewer 首页自动刷新（轮询 `/api/runs`）；`/runs/<id>` 路径穿越修复；suite / workflow 报告里的 run 链接改为相对路径，`file://` 打开不再失效。

**评审新列入的待办**

- 断言错误在更多路径上带 YAML 列号（故障解析已有 `file:line`）。
- 清理 `docs/technical.md` 中已超前的描述（桌面 adapter、SQLite、workflow 条件分支、磁盘/句柄故障均未实现），与本文档对齐。
- CLI 层（parseFlags / list / report / view）纳入常规回归测试（本轮已补一部分）。

---

## 1. Agent 接入

当前黑盒主要验证了 Codex CLI、ZCode CLI 和 `generic-cli` 替身。

- **Claude / Kimi 完整 adapter**：真实启动参数、session resume、审批绕过、能力声明，而不是只解析二进制名。
- **OpenCode、Cursor CLI、Zed/ACP**：设计范围里的其余 harness，统一走 `generic-cli` 或独立 adapter。
- **桌面客户端 adapter（`generic-desktop`）**：ChatGPT/Codex 桌面、Claude Desktop 等；控制窗口、发输入、检测无响应。依赖第 6 节平台 helper。
- **能力发现加深**：版本、平台、`cli` / `desktop-ui` / `session-resume` / `mcp` / `tool-events`，`unsupported` / `degraded` 覆盖到 adapter 级而不只是 helper 命令。

## 2. 终端、会话与输入

- **按事件注入输入**：`input.send` 目前按墙钟；审批回复、取消与完成竞态需要 native events。
- **真正的 session resume**：Codex `exec resume`、各家 session id / thread id 与 `session_resumable` 对齐；现在 `recovery.resume` 只覆盖 Codex 的有限路径。
- **轨迹级 replay 与 fuzzing**：按事件日志重放 tool/输出时间线，并随机打乱返回顺序、插话时刻、审批耗时、延迟、压缩触发点。现有 `replay` 是「用保存的 YAML 再跑一遍」，不是轨迹重放。

## 3. 故障类型补齐

已有种类不再列出。下列来自设计/技术文档，YAML 里还没有可用实现。

**LLM / 协议**

- Anthropic Messages 协议（现仅 OpenAI-compatible）
- MCP HTTP(S) 代理：delay / timeout / 429 / 坏 JSON / schema drift / 重复 chunk
- 上下文压缩故障（compaction 中断、压缩后状态漂移）

**工具与编排**

- MCP / subagent 故障：子 agent 被杀、工具超时、重复 tool call
- 审批与 sandbox：卡住审批、拒绝权限、sandbox 收紧
- Agent hooks 注入失败或被外部改写

**Workspace / Git / 资源**

- Git worktree 残留
- 磁盘满、句柄耗尽、巨量 stdout（超长流式输出）
- session 库文件锁（隔离副本，禁止打真实用户主目录）
- 更完整的 Windows ACL（现 `chmod` 只映射只读属性）
- 只杀某个子进程、不杀整树

**桌面 / OS**（依赖 helper）

- sleep / wake
- 窗口关闭、renderer crash、输入丢失
- 自动更新打断
- 系统权限对话框（TCC / UAC）

## 4. 事件、断言与证据

- **Native event adapter**：订阅 `approval_requested`、`tool_started`/`finished`、`compaction_started`、`session_checkpoint`、`subagent_finished`，而不是只从 stdout JSON 猜。没有这些事件就做不了完整影子执行（agent 认为的状态）和丢失消息/丢失 tool 结果计数。
- **事件字段补齐**：每条记录带 toolCallId、session revision、进程树快照、UI 状态（现有 JSONL 字段不完整）。
- **证据**：脱敏终端日志、截图、crash dump；报告里可点开。
- **指标**：丢失消息数、丢失 tool 结果数（依赖 native events）。recovery / resume / orphans / duplicate / takeover / divergence 已在报告里。
- **SQLite 事件存储**：跨 run 查询与比较；现为 JSONL + `index.jsonl`。

## 5. 编排与评测

- **Workflow 条件分支与定时调度**（Chaos Mesh 完整模型）。现仅 serial / parallel，失败即停。
- **矩阵对比**：同一 workload 下多 agent / 多 profile 并排比较。
- **Viewer 实时时间线**：WebSocket 推送 running 实验；键盘浏览 job。现 `view` 读已结束的 HTML。
- **长时 endurance runner**：按事件次数压缩时间（工具调用、上下文压缩、断连、重启、睡眠唤醒、并发 subagent），用 checkpoint 而不是墙钟小时当通过条件。
- **Property / model-based 测试**：状态机不变量（无孤儿进程、故障必恢复、workspace 不逃逸）。
- **完整影子执行**：每步比较 agent 视图 / harness 视图 / 文件系统与 Git；现在只有 harness + workspace/git/process 快照。
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

还不能打、已在上面分节里：超长流式输出（缺巨量 stdout 注入）、取消竞态、审批拒绝/关窗、OAuth、session DB 锁、compaction、磁盘满、乱码、只杀 child、worktree 残留、MCP 三类、hook、subagent、真 IDE 风暴、睡眠唤醒、自动更新、TCC。

明确不做（伪造杀软等）见 [design.md](./design.md) 的边界，不要当作路线图条目。

时间压缩、轨迹 fuzzing、完整三方影子执行见第 2 / 4 / 5 节，不要靠堆 YAML 冒充。

---

## 建议实现顺序（无日期）

只表达依赖，方便排期讨论：

1. 更完整的非 Codex adapter（PTY/ConPTY 已接入；不引入桌面权限）。
2. Native events、MCP 代理、审批/压缩故障（仍在 CLI 黑盒内）。
3. Git worktree / 磁盘 / 句柄、指标与证据补齐、Schema 与 compare。
4. Helper 版本化发布 + Mac/Windows 桌面 bridge；然后才是 `generic-desktop` 与桌面故障。
5. endurance runner、实时 viewer；若要做 Dashboard / CI Action / npm，按 [design.md](./design.md) 的产品形态，共用 runner API，且不取代 CLI 主入口。
