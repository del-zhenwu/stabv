# 场景表

本文档列出产品实验与场景编号的对应关系。示例项目均为 `examples/fixtures/broken-sum`（`add()` 实现有误，`node --test` 会失败）。安装后可修改 `agentchaos.yaml`，或运行 `examples/zcode.yaml`。`fixture` 与 `src/sum.js` 的说明见 [示例](../examples/README.md)。

如果你是按问题查实验：进程恢复看 11/22/24，文件并发变化看 16/35，网络恢复看 40，MCP 看 28-30，桌面证据和冻结看 8，资源极限看 18。

`examples/probe/` 使用 Node 替身，无需登录真实 Agent。产品实验应驱动真实工作循环（修改代码、运行测试、操作 Git）。

| 运行方式 | 覆盖场景 |
| --- | --- |
| `--workload workloads/codex-resume.yaml --profile profiles/process/kill-resume.yaml` | 11 / 22 / 24：修测试中途杀进程再接着跑 |
| `--workload workloads/codex.yaml --profile profiles/file/edit.yaml` | 16：正在改文件时外部改同一文件 |
| `--workload workloads/codex.yaml --profile profiles/file/storm.yaml` | 35（CLI 近似）：对同一文件连发外部写入 |
| `--workload workloads/codex.yaml --profile profiles/file/chmod.yaml` | 17：正在改的文件权限被收掉 |
| `--workload workloads/codex.yaml --profile profiles/file/large.yaml` | 15：目标文件被换成大 blob |
| `--workload workloads/codex.yaml --profile profiles/git/lock.yaml` | 25 / 26：`index.lock` + 冲突标记 |
| `--workload workloads/codex.yaml --profile profiles/network/delay.yaml` | 40：网络卡住再恢复后继续长任务 |
| `examples/suites/zcode.yaml` | ZCode × 改文件 / 杀进程 / 429 / 500 / 截断 / auto |
| `examples/suites/cli-agents.yaml` | 同一份杀进程和 429，分别挂 ZCode / Codex / Claude / Kimi |
| `examples/probe/mcp-upstream-proxy.yaml` | 28 / 29：MCP stdio 真实上游代理与副作用去重隔离 |
| `examples/probe/subagent-checkpoint.yaml` | 22 / 33：子 Agent 派生、检查点建立与崩溃恢复 |
| `examples/probe/session-schema-drift.yaml` | 12：隔离 Session 表结构漂移与版本冲突恢复 |
| `examples/probe/desktop-screenshot.yaml` | 8：原生桌面截屏证据捕获与冻结探测 |
| `examples/probe/remote-lifecycle.yaml` | 10：远端协调器租约申请、心跳超时与断连恢复 |
| `examples/probe/resource-exhaustion.yaml` | 18：真实 EMFILE 句柄耗尽与 ENOSPC 磁盘写满极限压测 |

协议层探测（LLM / MCP 代理）：

```bash
./agentchaos run examples/zcode.yaml
./agentchaos suite examples/suites/protocol.yaml
```

**Windows**

```bat
.\agentchaos.cmd run --workload examples\workloads\codex-resume.yaml --profile examples\profiles\process\kill-resume.yaml
.\agentchaos.cmd run --workload examples\workloads\codex.yaml --profile examples\profiles\file\storm.yaml
.\agentchaos.cmd suite examples\suites\protocol.yaml
.\agentchaos.cmd suite examples\suites\zcode.yaml
```

**macOS / Linux**

```bash
./agentchaos run --workload examples/workloads/codex-resume.yaml --profile examples/profiles/process/kill-resume.yaml
./agentchaos run --workload examples/workloads/codex.yaml --profile examples/profiles/file/storm.yaml
./agentchaos suite examples/suites/protocol.yaml
./agentchaos suite examples/suites/zcode.yaml
```

登录失败或出现验证码时，只要进程已启动，仍可核验故障是否注入、是否残留进程。报告中的恢复比例、残留进程与重复工具副作用应与检查项分开阅读。

## 40 个高价值场景

| # | 场景 | 现状 | 运行方式 / 缺口 |
| --- | --- | --- | --- |
| 1 | 超长流式输出 | 部分 | PTY 通道已通；还没有「巨量 stdout」注入 |
| 2 | SSE 中途断开 | 能（协议） | `llm.truncate` / `llm.timeout`：`examples/probe/llm-truncate.yaml`、`examples/probe/llm-timeout.yaml`。Codex 若不认 `OPENAI_BASE_URL` 则为 degraded |
| 3 | tool JSON 截断 / 字段级值故障 | 能（协议） | `llm.truncate` + `field: tool_calls`、`llm.malformed`、`llm.empty` / `corrupt` / `stale_data` / `wrong_entity`：`examples/probe/llm-field-tool-calls.yaml`、`examples/suites/llm-api.yaml` |
| 4 | tool result 重复 | 能（协议） | `llm.duplicate`：`examples/probe/llm-duplicate.yaml` |
| 5 | 用户快速连发 | 能 | `input.send` 可按时间或 `when`：`examples/probe/input-send.yaml`、`examples/probe/pty-echo.yaml` |
| 6 | 取消与完成竞态 | 部分 | runner 有 SIGINT 取消；还没有 YAML `cancel` 打在 `tool_finished` 瞬间 |
| 7 | 审批拒绝后重试 | 能（CLI） | `approval.deny`：`examples/probe/approval-deny.yaml`。桌面审批弹窗仍不能 |
| 8 | 审批弹窗关闭/发送输入/冻结/截图 | 能（原生桌面桥） | 原生 `desktop.close_window` / `desktop.send_text` / `desktop.screenshot` / `desktop.freeze` 已调用真实系统 API；支持截屏证据断言 `desktop_screenshot_captured` 与挂起探测 `desktop_unresponsive_detected`：`examples/probe/desktop-screenshot.yaml` |
| 9 | token 过期 | 能（协议） | `llm.401`：`examples/probe/llm-401.yaml` |
| 10 | 远端生命周期与心跳租约超时 | 能（云端协调器） | `remote.disconnect` / `remote.heartbeat_timeout` / `remote.lease_expire` + 断言 `remote_lease_valid`、`remote_reconnect_success`：`examples/probe/remote-lifecycle.yaml` |
| 11 | session 写入时杀进程 | 能 | ``workloads/codex-resume` + `profiles/process/kill-resume``（`ephemeral: false` + resume） |
| 12 | 隔离 session 文件锁/损坏/结构漂移 | 能（隔离） | `target.sessionHome` + `session.lock|corrupt|truncate|schema_drift` 操作真实文件；断言 `session_clean_recovery`：`examples/probe/session-schema-drift.yaml` |
| 13 | 上下文压缩中断 | 能（杀进程） | `compaction.interrupt`：`examples/probe/compaction-interrupt.yaml`。压缩后状态漂移还没有 |
| 14 | 压缩后继续执行 | 部分 | 可对 `compaction.interrupt` 加 `recovery.restart`；没有压缩后语义断言 |
| 15 | 大文件 patch | 能 | `file.edit` + `sizeBytes`：``profiles/file/large.yaml``、`examples/probe/file-large.yaml` |
| 16 | 文件被外部修改 | 能 | ``workloads/codex` + `profiles/file/edit`` |
| 17 | 文件权限变化 | 能 | ``workloads/codex` + `profiles/file/chmod``（Windows 映射为只读属性） |
| 18 | 有界磁盘压力与极限耗尽 | 能（真实极限与压力） | `resource.disk`（有界临时填充分配）、`resource.disk_exhaustion`（真实工作区写满 ENOSPC）与 `resource.handle_exhaustion`（真实 EMFILE 描述符耗尽），断言 `resource_exhaustion_recovered`：`examples/probe/disk-stress.yaml`、`examples/probe/resource-exhaustion.yaml` |
| 19 | shell 启动失败 | 部分 | 可用 `file.chmod` 让脚本不可执行；没有独立的「shell spawn 失败」注入 |
| 20 | 交互式命令阻塞 | 部分 | PTY 已通；还没有「阻塞在 read」注入 |
| 21 | shell 输出乱码 | 不能 | 需要 PTY 与编码注入 |
| 22 | 子进程被杀与检查点恢复 | 能（只杀 child 与检查点） | `subagent.kill` / `subagent.checkpoint` / helper `kill-process` 仅终止特定子进程并验证检查点回滚：`examples/probe/subagent-kill.yaml`、`examples/probe/subagent-checkpoint.yaml`；整树使用 `process.kill` |
| 23 | 端口占用 | 能 | `resource.port`：`examples/probe/resource-port.yaml` |
| 24 | 孤儿进程清理 | 能 | 杀树后断言 `no_orphan_process`；报告 `orphans` |
| 25 | Git lock | 能 | ``workloads/codex` + `profiles/git/lock`` |
| 26 | merge conflict | 能 | 同上 `git.conflict` |
| 27 | worktree 残留 | 能 | `git.worktree-leak` / `git.worktree-lock` + 断言 `git_worktree_clean`：`examples/probe/git-worktree.yaml` |
| 28 | MCP 启动失败与半写入 | 能（HTTP / stdio） | `mcp.malformed` / `mcp.500` / `mcp.crash` / `mcp.partial_write` / `mcp.chunked`；支持 HTTP 代理与 stdio 包装器上游副作用去重隔离与重放（`mcp_stdio_upstream_consistent`）。`examples/probe/mcp-stdio.yaml`、`examples/probe/mcp-upstream-proxy.yaml` |
| 29 | MCP 超时 | 能（HTTP / stdio） | `mcp.timeout`：`examples/probe/mcp-timeout.yaml`、`examples/probe/mcp-stdio.yaml` |
| 30 | MCP 大 payload | 能（HTTP / stdio） | `mcp.oversized`：`examples/probe/mcp-oversized.yaml` |
| 31 | hook 拒绝 | 不能 | hook 注入 |
| 32 | hook 递归 | 不能 | 同上 |
| 33 | subagent 永不返回 | 能 | `subagent.timeout`（暂停目标子进程树，超时或恢复时 resume）：`examples/probe/subagent-kill.yaml` |
| 34 | subagent 并发写同文件 | 能 | `subagent.conflict` 注入并发同名文件修改：`examples/probe/subagent-kill.yaml` |
| 35 | IDE 文件事件风暴 | 部分 | ``workloads/codex` + `profiles/file/storm`` 连发 `file.edit`，不是 IDE watcher |
| 36 | 睡眠唤醒 | 不能 | helper sleep/wake；roadmap 第 6 节 |
| 37 | 自动更新中断 | 不能 | 桌面 |
| 38 | Mac 权限撤销 | 不能 | TCC；roadmap 第 6 节 |
| 39 | Windows Defender 拦截 | 不能 | 不在 helper 里伪造杀软 |
| 40 | 网络恢复后继续长任务 | 能（degraded） | ``workloads/codex` + `profiles/network/delay``；目标必须认 `HTTP(S)_PROXY` |

已落地能力附带对应故障与 YAML。能力缺口见 [roadmap.md](./roadmap.md)。边界见 [design.md](./design.md)。

## 长时暴露的问题

下列能力需要独立的 runner 支持：

| 方法 | 现状 | 处理 |
| --- | --- | --- |
| 时间压缩（按工具次数 / 压缩次数 / 断连次数，而不是等几天） | 不能 | roadmap：长时 endurance runner |
| 任务轨迹 fuzzing（打乱 tool 顺序、插话、审批、延迟、压缩点） | 不能 | roadmap：轨迹存储 + 变异重放。现有 `replay` 只是再跑同一份 YAML |
| 影子执行（agent 认为的状态 / harness 记录 / 文件系统与 Git 逐步比对） | 部分 | `shadow_compare` 含 harness 已注入、workspace hash、git lock、进程是否活着，以及 agent 侧 pending tools / last native / session id。还不是逐步语义对齐 |
| 可恢复性一等指标 | 能（持续补齐） | 报告：`recoveryRate`、`mttrMs`、`restarts`、`resumeSuccess`、`reworkRatio`、`duplicateSideEffectRate`、`orphanCount`、`userInterventionCount`、`stateDivergence`、`lostToolResults`。丢失消息数仍缺 |

组合故障优先于复制单故障 YAML。例如在 Workflow 中串联「git lock ∥ 外部修改文件 → kill → resume」。
