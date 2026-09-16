# 稳定性实验

例子要少，但必须打在真实 agent 的真实工作循环上（改代码、跑测试、碰 Git），而不是 `setTimeout`。控制面单测仍可用 `examples/*-fast.yaml` 和 Node 替身，那些不算产品实验。

推荐产品集（同一份 `examples/fixtures/broken-sum`：`add()` 算错，测试会失败）：

| 文件 | 覆盖的场景 |
| --- | --- |
| `examples/codex-kill-resume.yaml` | 11 / 22 / 24：修测试中途杀进程再 resume |
| `examples/codex-file-edit.yaml` | 16：正在 patch 时外部改同一文件 |
| `examples/codex-file-storm.yaml` | 35（CLI 近似）：对同一文件连发外部写入 |
| `examples/codex-chmod.yaml` | 17：正在改的文件权限被收掉 |
| `examples/codex-large-patch.yaml` | 15：目标文件被换成大 blob |
| `examples/codex-git-lock.yaml` | 25 / 26：`index.lock` + 冲突标记 |
| `examples/codex-network-delay.yaml` | 40：网络卡住再恢复后继续长任务 |
| `examples/zcode-process-kill.yaml` | 22 / 24：另一套 CLI 的进程树清理 |

协议层（真实 HTTP 客户端打 runner 的 LLM 代理，不依赖 Codex 登录）：

```bash
./agentchaos run examples/suite-protocol.yaml
```

**Windows**

```bat
.\agentchaos.cmd run examples\codex-kill-resume.yaml
.\agentchaos.cmd run examples\codex-file-storm.yaml
.\agentchaos.cmd run examples\suite-protocol.yaml
```

**macOS / Linux**

```bash
./agentchaos run examples/codex-kill-resume.yaml
./agentchaos run examples/codex-file-storm.yaml
./agentchaos run examples/suite-protocol.yaml
```

模型 403 / 验证码失败时，只要进程曾起来，`fault_injected` 和 `no_orphan_process` 仍有意义。不要把 `exit_zero` 或「测试被修好」当成唯一通过条件。报告里的 **recovery / resume / orphans / duplicate tools / state diverge / user takeover** 是可恢复性指标，和断言分开看。

## 40 个高价值场景

| # | 场景 | 现状 | 怎么跑 / 缺口 |
| --- | --- | --- | --- |
| 1 | 超长流式输出 | 部分 | PTY 通道已通；还没有「巨量 stdout」注入 |
| 2 | SSE 中途断开 | 能（协议） | `llm.truncate` / `llm.timeout`：`examples/llm-truncate.yaml`、`examples/llm-timeout.yaml`。Codex 若不认 `OPENAI_BASE_URL` 则为 degraded |
| 3 | tool JSON 截断 | 能（协议） | `llm.truncate`、`llm.malformed` |
| 4 | tool result 重复 | 能（协议） | `llm.duplicate`：`examples/llm-duplicate.yaml` |
| 5 | 用户快速连发 | 能（按时间） | `input.send`：`examples/input-send.yaml`、`examples/pty-echo.yaml`。还不是按事件触发 |
| 6 | 取消与完成竞态 | 部分 | runner 有 SIGINT 取消，YAML 还不能按事件触发「完成瞬间取消」 |
| 7 | 审批拒绝后重试 | 不能 | 需要审批事件 + `send_input` |
| 8 | 审批弹窗关闭 | 不能 | 桌面 UI Automation |
| 9 | token 过期 | 能（协议） | `llm.401`：`examples/llm-401.yaml` |
| 10 | OAuth 回调失败 | 不能 | 桌面 / 浏览器回调 |
| 11 | session 写入时杀进程 | 能 | `examples/codex-kill-resume.yaml`（`ephemeral: false` + resume） |
| 12 | session 数据库锁 | 不能 | 不能锁真实用户主目录里的 session DB；roadmap |
| 13 | 上下文压缩中断 | 不能 | compaction 故障；roadmap 第 3 节 |
| 14 | 压缩后继续执行 | 不能 | 同上 |
| 15 | 大文件 patch | 能 | `file.edit` + `sizeBytes`：`examples/codex-large-patch.yaml`、`examples/file-large.yaml` |
| 16 | 文件被外部修改 | 能 | `examples/codex-file-edit.yaml` |
| 17 | 文件权限变化 | 能 | `examples/codex-chmod.yaml`（Windows 映射为只读属性） |
| 18 | 磁盘满 | 不能 | helper 磁盘压力；roadmap 第 3 节。`sizeBytes` 上限 16MiB，不是磁盘满 |
| 19 | shell 启动失败 | 部分 | 可用 `file.chmod` 让脚本不可执行；没有独立的「shell spawn 失败」注入 |
| 20 | 交互式命令阻塞 | 部分 | PTY 已通；还没有「阻塞在 read」注入 |
| 21 | shell 输出乱码 | 不能 | 需要 PTY 与编码注入 |
| 22 | 子进程被杀 | 能（整树） | `process.kill` 杀的是整棵进程树，不能只杀某个 child |
| 23 | 端口占用 | 能 | `resource.port`：`examples/resource-port.yaml` |
| 24 | 孤儿进程清理 | 能 | 杀树后断言 `no_orphan_process`；报告 `orphans` |
| 25 | Git lock | 能 | `examples/codex-git-lock.yaml` |
| 26 | merge conflict | 能 | 同上 `git.conflict` |
| 27 | worktree 残留 | 不能 | roadmap 第 3 节 |
| 28 | MCP 启动失败 | 不能 | MCP 代理；roadmap 第 3 节 |
| 29 | MCP 超时 | 不能 | 同上 |
| 30 | MCP 大 payload | 不能 | 同上 |
| 31 | hook 拒绝 | 不能 | hook 注入 |
| 32 | hook 递归 | 不能 | 同上 |
| 33 | subagent 永不返回 | 不能 | subagent 故障 |
| 34 | subagent 并发写同文件 | 部分 | 可用外部 `file.edit` 近似；没有真 subagent |
| 35 | IDE 文件事件风暴 | 部分 | `examples/codex-file-storm.yaml` 连发 `file.edit`，不是 IDE watcher |
| 36 | 睡眠唤醒 | 不能 | helper sleep/wake；roadmap 第 6 节 |
| 37 | 自动更新中断 | 不能 | 桌面 |
| 38 | Mac 权限撤销 | 不能 | TCC；roadmap 第 6 节 |
| 39 | Windows Defender 拦截 | 不能 | 不在 helper 里伪造杀软 |
| 40 | 网络恢复后继续长任务 | 能（degraded） | `examples/codex-network-delay.yaml`；目标必须认 `HTTP(S)_PROXY` |

**能支持的已经落地**（故障 + 实验 YAML）。**不能支持、但属于能力缺口的**见 [roadmap.md](./roadmap.md)。不要为了凑 40 条去打真实主目录或伪造杀软（边界见 [design.md](./design.md)）。

## 长时间才暴露的问题

这些不是再加 20 个 YAML 就能替代的，要单独做 runner 能力：

| 方法 | 现状 | 处理 |
| --- | --- | --- |
| 时间压缩（按工具次数 / 压缩次数 / 断连次数，而不是等几天） | 不能 | roadmap：长时 endurance runner |
| 任务轨迹 fuzzing（打乱 tool 顺序、插话、审批、延迟、压缩点） | 不能 | roadmap：轨迹存储 + 变异重放。现有 `replay` 只是再跑同一份 YAML |
| 影子执行（agent 认为的状态 / harness 记录 / 文件系统与 Git 逐步比对） | 部分 | 每步注入后写 `shadow_compare`（harness 已注入列表、workspace hash、git lock、进程是否活着）。还没有「agent 认为的状态」，缺 native tool/session 事件 |
| 可恢复性一等指标 | 能（持续补齐） | 报告：`recoveryRate`、`mttrMs`（全部故障-恢复对的均值）、`restarts`、`resumeSuccess`（resume 后 session id 连续才算成功，观测不到则留空）、`reworkRatio`、`duplicateSideEffectRate`、`orphanCount`、`userInterventionCount`、`stateDivergence`。丢失消息数仍缺 native 事件 |

组合故障仍比复制单故障 YAML 更有用。Workflow 里把「git lock ∥ 外部改文件 → kill → resume」串起来，优于再加几十个 smoke。
