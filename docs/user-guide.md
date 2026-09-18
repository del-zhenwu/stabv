# AgentChaos 用户手册

## 1. 概述

本文档介绍如何安装 AgentChaos、编写实验 YAML，以及查看运行报告。

AgentChaos 按 YAML 指定 Agent 与故障类型，在隔离工作区中注入，并核对进程、会话与工作区状态。

```text
编写 YAML → agentchaos run → agentchaos view
```

实验在 `.agentchaos-runs/` 中执行。prompt 中的 `src/sum.js` 来自 `fixture` 指定的项目，说明见 [示例](../examples/README.md)。

---

## 2. 安装与首次运行

### 环境准备

- Node.js 22 或更高版本
- 安装包已包含 helper

安装包自带 `examples/zcode.yaml`：adapter 为 zcode，`inject` 覆盖安装包中的全部故障类。

```yaml
spec:
  target:
    adapter: zcode
  fixture: broken-sum
  inject:
    - llm
    - resource
    - file
    - git
    - network
    - process
```

### Windows 10+

```bat
npm install -g agentchaos
agentchaos run examples\zcode.yaml
agentchaos view --open
```

### macOS / Linux

```bash
npm install -g agentchaos
agentchaos run examples/zcode.yaml
agentchaos view --open
```

- 默认 `fixture: broken-sum` 是安装包自带的示例工程（`src/sum.js` 故意算错），运行时复制到 `.agentchaos-runs/`。
- 测试自己的代码：将 `fixture` 改为工程绝对路径。
- 更换 Agent：复制该 YAML 并修改 `adapter`。
- 跑 ZCode 前填写三项：API Key、网关地址、模型名。已经设过 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 的，可以沿用，不必再写一遍。

Windows 10+：

```bat
set ZCODE_API_KEY=sk-...
set ZCODE_BASE_URL=https://你的网关
set ZCODE_MODEL=你的模型
```

macOS / Linux：

```bash
export ZCODE_API_KEY=sk-...
export ZCODE_BASE_URL=https://你的网关
export ZCODE_MODEL=你的模型
```

从本仓库源码开发时，请使用 `scripts\setup.cmd` 或 `./scripts/setup.sh`。

### 2.1 第一次运行检查清单

1. `node --version` 至少为 22。
2. 先运行 `agentchaos validate examples/zcode.yaml`，确认 fixture、Agent 和 Helper 能力。
3. 使用 ZCode 时设置 `ZCODE_API_KEY`、`ZCODE_BASE_URL`、`ZCODE_MODEL`；也兼容 Actions 常用的 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`；只测试控制面可运行 `examples/probe/codex-smoke.yaml`。
4. 运行 `agentchaos run ...`，再用 `agentchaos view --open` 查看报告。

### 2.2 常见问题

- **找不到 fixture**：示例短名只适用于安装包内的 `examples/fixtures`；自己的工程请使用绝对路径。
- **找不到 Agent**：设置对应的 `*_BIN`，或在 YAML 中填写 `target.executable`。
- **显示 `degraded`**：实验仍可能运行，但某项能力只能近似验证，例如 Agent 不使用代理或 Helper 没有 PTY。
- **显示 `unsupported`**：实验不会被误报为通过；请改用支持的 Agent、平台或故障类型。
- **计划故障没有注入**：查看报告中的 `blockReason`，这通常是登录、网关或 Agent 启动配置问题，而不是可靠性失败。

---

## 3. 命令

安装后使用 `agentchaos`。从本仓库运行时，Windows 使用 `.\agentchaos.cmd`，macOS / Linux 使用 `./agentchaos`。

| 命令 | 说明 |
| --- | --- |
| `agentchaos run [spec]` | 跑指定 YAML。不写路径时：当前目录有 `agentchaos.yaml` 就用它，否则用安装包 `examples/zcode.yaml`。 |
| `agentchaos validate [spec]` | 校验 YAML，并打印 `fixture` 的真实路径。 |
| `agentchaos suite <suite.yaml>` | 批量执行。`--repeat N` 时需连续 N 次通过 |
| `agentchaos workflow <workflow.yaml>` | 按串行或并行执行多步 |
| `agentchaos view [--open] [--port 8080]` | 打开本地报告 |
| `agentchaos report <id>` | 查看任务或单条报告。`--json` 输出原始数据 |
| `agentchaos watch <run-id>` | 跟踪该次运行的 `events.jsonl` |
| `agentchaos replay <run-id>` | 按已记录的故障再次执行 |
| `agentchaos compare <report.json> <report.json> ...` | 按故障维度汇总多份报告；`--json` 输出可查询矩阵 |
| `agentchaos endurance <spec> --repeat N` | 重复运行实验并输出通过率与失败 run ID |
| `agentchaos recover <run-id>` | 清理该次运行可能残留的进程 |

---

## 4. 编写实验 YAML

实验至少指定目标 Agent 与故障类别。系统会展开组合；报告首先展示该组合，再列出各条结果。

```yaml
# examples/zcode.yaml
spec:
  target:
    adapter: zcode
    prompt: "Fix src/sum.js so `node --test` passes."
    json: true
    bypassApprovals: true
  fixture: broken-sum   # 安装包 examples/fixtures/broken-sum；自己的工程写绝对路径
  inject:
    - llm
    - resource
    - file
    - git
    - network
    - process
```

```bash
agentchaos run examples/zcode.yaml
agentchaos view --open
```

`fixture: broken-sum` 是安装包内 `examples/fixtures/broken-sum/` 的短名，运行时复制到隔离工作区。`prompt` 中的 `src/sum.js` 指复制后的文件。针对自有项目时，请写绝对路径，例如 `fixture: /path/to/your/project`。

`inject` 里写类名，会挂上 `examples/profiles/<类>/` 下的全部故障。默认入口只包含常用的 LLM、资源、文件、Git、网络、进程六类；MCP、桌面、会话、子 Agent、远程、规则和上下文故障需要显式加入。写成 `inject: { llm: [429, 500], resource: cpu }` 则仅注入所列条目。`together: true` 表示在同一轮中同时注入多类故障。

每个 run 会生成 `events.jsonl` 及同目录的 `events.index.json`。后者是无依赖的事件计数索引，可由工具或脚本查询；事件日志不完整时索引会跳过损坏行。`agentchaos view` 使用 SSE 自动刷新运行列表。`replay` 重放记录的 strike 轨迹；库 API 的 `fuzzFaults` 可用固定 seed 产生可复现的时序扰动。显示器热插拔与 DPI 仍明确标记为 unsupported。

如需逐条声明故障，可使用完整写法：

```yaml
apiVersion: agentchaos.dev/v1alpha1
kind: Experiment
metadata:
  name: tool-failure-recovery
spec:
  # 1. 目标 Agent 配置
  target:
    adapter: generic-cli               # codex | claude | kimi | zcode | opencode | cursor | zed | generic-cli
    executable: node                   # 目标程序执行文件
    args:                              # 启动参数列表（避免平台差异）
      - -e
      - "console.log('started'); setTimeout(() => process.exit(0), 1000);"
    env:                               # 注入的环境变量
      MY_VAR: "true"
    sessionHome: codex-home            # 相对 run 根目录的真实 session 存储隔离目录

  # 2. 工作区
  fixture: broken-sum                  # 短名 = examples/fixtures/broken-sum；也可写绝对路径
  git: true                            # 是否在隔离目录里 git init

  # 3. 运行超时
  timeout: 15s                         # 支持 500ms / 10s / 2m

  # 4. 混沌故障注入列表（可同时配置多个，按时序注入）
  faults:
    - type: mcp
      action: 429
      at: 100ms                        # 相对实验开始的时间，或配合 when 使用
      duration: 300ms                  # 可恢复故障的作用窗口
    - type: subagent
      action: kill
      when: subagent_started           # 事件触发：检测到对应 native 事件后注入
      at: 50ms                         # 在事件发生后延迟 50ms 注入

  # 5. 自愈与恢复配置
  recovery:
    restart: false                     # 进程退出后是否自动拉起
    resume: false                      # 重启时是否尝试恢复会话 session

  # 6. 结束时核对的检查项
  assertions:
    - exit_zero
    - not_timed_out
    - no_orphan_process
    - git_worktree_clean
    - subagent_exactly_once
```

### 事件触发机制 (`when`)
除了通过墙钟时间 `at: 2s` 定时注入外，AgentChaos 支持在 Agent 输出特定行为时**动态触发**故障：
- `tool_started` / `tool_finished`：工具调用开始或结束时。
- `approval_requested`：检测到 Agent 正在请求人工审批确认时。
- `compaction_started` / `compaction_finished`：上下文压缩开始或完成时。
- `session_checkpoint`：会话检查点写盘时。
- `subagent_started` / `subagent_finished`：子 Agent 派生或完成时。

`subagent_exactly_once` 读取运行目录中的 `subagents.jsonl`，检查每个可观测 subagent id 恰好一次启动和一次终态。`subagent_resume_consistent` 进一步要求同一 id 在一次真实恢复循环的不同 generation 中重新出现，restart 边界存在、session id 不漂移且最终只有一个终态；它不覆盖远程 subagent 或 checkpoint 数据库恢复。

MCP stdio wrapper 会把 request、已提交 response 和跨进程 `response_replay` 追加到 `mcp-stdio.jsonl`。`mcp_stdio_exactly_once` 检查单进程一请求一响应；`mcp_stdio_resume_consistent` 要求同一 request id 在两个真实 wrapper 进程中出现、只有一个已提交 response 且第二次是 replay。半写入和真实上游副作用仍需专用协议/环境才能验证。

### 4.2 规则模式与自主模式

默认规则模式由 YAML 中的 `faults` 决定注入内容。若需由规划器选择故障，请设置 `mode: auto`：

```yaml
spec:
  mode: auto
  budget: 3
  target:
    adapter: zcode
    prompt: "Fix src/sum.js so `node --test` passes."
    json: true
    bypassApprovals: true
  fixture: broken-sum
```

省略 `assertions` 时，系统按本次实验补齐可观测的检查项：是否超时、是否残留进程、Git 锁与仓库状态、同一工具是否重复执行、工具结果是否丢失。配置了可恢复故障或 `mode: auto` 时，还会检查恢复后进程是否仍有活动。YAML 中声明的故障会核验是否实际注入。配置了 `verify` / `expected` 或会话恢复时，也会一并核对。判定仅依据上述实测结果。需要收窄或增加检查项时，请显式列出 `assertions`。

自主模式使用独立的模型密钥（与被测 Agent 的登录无关）：

```bash
export AGENTCHAOS_LLM_API_KEY=...
# 可选：AGENTCHAOS_LLM_BASE_URL、AGENTCHAOS_LLM_MODEL
./agentchaos run examples/cases/auto.yaml
```

未设置密钥时实验会失败。`replay` 以规则模式重放已记录的故障。将 `zcode` 替换为 `codex` / `claude` / `kimi` 即可切换目标 Agent。

### 4.3 解析本机 Agent

可执行文件的解析顺序为：YAML 中的 `target.executable` → 环境变量（`ZCODE_BIN`、`CODEX_BIN`、`CLAUDE_BIN`、`KIMI_BIN`）→ 系统 `PATH` → 常见安装位置。若未找到，请设置对应的 `*_BIN`。

故障触发依据各 Agent 协议中的事件类型（工具开始、审批、压缩），而不是对对话文本做模糊匹配。

### 4.4 停滞与重试风暴

进程存活并不表示任务仍在推进：

1. **I/O 停滞**：进程存活，但持续无输出。
2. **重试风暴**：短时间内密集出现失败日志，状态未前进。

到达阈值后即停止等待。可配置：
```yaml
spec:
  ioStallTimeout: 6s                  # 当 Agent 进程存活但持续 6s 无任何输出且未推进时，触发 watchdog_io_stalled
  retryStormThreshold: 4              # 滑动窗口内检测到 4 次及以上密集报错/重试时，触发 watchdog_retry_storm
  retryStormWindow: 3s                # 滑动窗口时间跨度（默认 3s）
```
触发重试风暴时，报告会记录 `RETRY_STORM_DEADLOCK`，并提示增加退避或熔断。

### 4.5 重放（`replay`）

`mode: auto` 产生的结果可通过已记录的故障再次执行：

Windows:

```bat
.\agentchaos.cmd replay 689c709f-bc33-45b2-b468-cd4fefa33719
```

macOS / Linux:

```bash
./agentchaos replay 689c709f-bc33-45b2-b468-cd4fefa33719
```

### 4.6 LLM 代理

未配置上游时，代理直接返回 429、500 或截断，用于控制面验证。

若需转发到真实模型，请设置 `AGENTCHAOS_LLM_UPSTREAM`（例如 `https://api.anthropic.com`）。无故障窗口内原样转发；注入窗口内改为 429 或截断等，窗口结束后恢复转发。

---

## 5. 证据来源

- **`[EMPIRICAL]`**：本次运行中实际发生的事实，例如代理返回 429、进程被终止、文件锁仍存在、已截取屏幕。
- **`[STATIC_PROBE]`**：由外部探针根据代码静态推断，并非本次实验注入的结果。
- **`[AGENT_INFERENCE]`**：根据时间线作出的因果推断。

结构化摘要位于 `report.diagnosis.json`：

- **`invariantsViolated`**：未通过的检查项。
- **`causalChain`**：注入之后代理与进程的先后行为。
- **`suggestedFixPattern`**：常见修复方向（退避、进程组、去重）。
- **`reproductionSpecSnippet`**：用于复现的 YAML 片段。

---

## 6. 故障注入参考手册

AgentChaos 现已支持涵盖 Agent 全生命周期的 12 类故障原语：

| 分类 (`type`) | 动作 (`action`) | 注入行为与作用机制 | 自愈/恢复能力 |
| --- | --- | --- | --- |
| **`process`** | `kill` | 杀掉 Agent 主进程树（Unix: SIGKILL，Windows: Job Object）。 | 配合 `recovery.restart/resume` |
| | `pause` | 挂起进程执行（SIGSTOP / Windows 挂起线程）。 | 在 `duration` 结束后自动 resume |
| | `restart` | 强制终止后由 Harness 重新拉起。 | 立即重新启动 |
| **`subagent`** | `kill` / `fail` | 仅定向杀死子 Agent/子进程，保持主 Agent 存活。 | 验证主 Agent 能否捕获子任务失败 |
| | `timeout` | 挂起子进程树。 | 在 `duration` 到期后恢复唤醒 |
| | `checkpoint` | 在子 Agent 执行前记录检查点，验证失败后状态回滚。 | 无需恢复 |
| | `conflict` | 在子 Agent 执行期间修改工作区文件制造并发冲突。 | 无需恢复 |
| **`session`** | `corrupt` / `truncate` / `lock` | 在 `target.sessionHome` 隔离目录内对真实 session 文件写入损坏、截断或持有排他文件锁。 | 验证 Agent 对真实 session 存储故障的行为 |
| | `schema_drift` | 注入版本冲突或畸变 SQLite 表结构，验证 Agent 能否平滑降级或重建会话。 | 验证会话数据库恢复能力 |
| **`desktop`** | `screenshot` | 调用原生 OS 接口截取真实屏幕/窗口图像并存入 run 证据目录。 | 验证桌面证据采集断言 |
| | `freeze` | 挂起桌面 UI 进程树，模拟无响应渲染冻结。 | `duration` 结束后恢复 |
| | `close_window` / `send_text` | 原生触发关闭前台窗口或向前台发送按键序列。 | 验证 UI 中断恢复能力 |
| **`remote`** | `disconnect` / `heartbeat_timeout` / `lease_expire` | 通过内置 `RemoteCoordinator` 注入远端云端协调器断连、心跳超时、租约强制失效。 | `duration` 结束后恢复正常通信 |
| **`resource`** | `handle_exhaustion` | 真实极限测试：在隔离工作进程中耗尽可用文件描述符（EMFILE），验证 Agent 在句柄饥饿下的容错与恢复。 | `duration` 结束后释放全部句柄 |
| | `disk_exhaustion` | 真实极限测试：快速写满隔离工作区直至触发真实 ENOSPC 磁盘耗尽，并在结束后自动清理。 | `duration` 结束后释放空间并验证工作区可写 |
| | `disk` | 有界压力测试：填充分配指定大小（MB）的磁盘临时文件。 | `duration` 结束后自动释放并清理 |
| | `cpu` / `memory` | 占用多核 CPU 忙循环或占用指定物理内存（受宿主机健康看门狗保护）。 | `duration` 结束后自动停止释放 |
| | `port` | 预先绑定占用特定的本机 TCP 端口。 | `duration` 结束后释放端口 |
| **`mcp`** | `429` / `500` / `delay` / `timeout` / `malformed` / `oversized` / `crash` | 对 MCP 通信注入协议级故障。支持 HTTP 代理与 Stdio 模式。 | `duration` 结束后切回 `pass` |
| | `partial_write` / `chunked` | 在 Stdio 模式下向 Agent 写入截断的半帧 JSON-RPC 或分块渐进帧。 | 验证 Agent 对不完整 stdio 帧的处理能力 |
| **`file`** | `edit` | 外部静默篡改文件，支持 `sizeBytes` 写入大文件。 | 不可逆变更 |
| | `delete` / `rename` | 外部删除或重命名关键源文件。 | 不可逆变更 |
| | `chmod` | 修改文件权限（Windows 映射为只读属性）。 | 持续生效 |
| | `lock` | 对文件施加系统排他锁（flock / LockFileEx）。 | 在 `duration` 结束后自动释放 |
| **`git`** | `lock` | 制造 `.git/index.lock` 文件锁。 | 在 `duration` 结束后自动删除 |
| | `conflict` | 向工作区写入冲突合并标记。 | 不可逆变更 |
| | `switch-branch` | 强制切换底层 Git 分支。 | 不可逆变更 |
| | `worktree-leak` | 额外创建残留的 Git secondary worktree。 | 在 `duration` 结束后自动清理 |
| | `worktree-lock` | 创建并锁定次级 worktree。 | 在 `duration` 结束后解锁并清理 |
| **`llm`** | `401` / `429` / `500` / `degrade` | 本地透明代理返回认证失败、速率限制或服务端错误。`degrade` 先延迟再返回 500。同时支持 OpenAI 与 Anthropic Messages 协议。 | `duration` 结束后切回正常通过 |
| | `truncate` | 默认 SSE 中途断开；`field: content` 时截断文本并设 `finish_reason=length`；`field: tool_calls` 时只截断工具参数。 | 验证 Agent 重试与半包解析 |
| | `empty` | 安全过滤：清空或替换 `content`，去掉 `tool_calls`。可用 `scene: content_filter`。 | 验证拒答后的恢复 |
| | `corrupt` / `html` | 合法 JSON 内插入乱码，或把正文换成 HTML 502 页。 | 验证值故障与代理错误页 |
| | `stale_cache` / `stale_data` / `wrong_entity` | 回放上一次响应、把工具参数换成过期路径、或换成长得像的错误实体。 | 验证对“几乎正确”假结果的校验 |
| | `duplicate` | 发送重复 content chunk 或完整重复响应。 | 验证 Agent 去重防刷能力 |
| | `schema_drift` | 返回缺少必需字段或注入异形属性；`field: tool_calls` 时只改工具名/参数类型。 | 验证容错解析能力 |
| | `delay` / `timeout` | 模拟推理超时或大延迟。 | `duration` 结束后恢复 |
| | 时间表 | `schedule: single\|persistent\|intermittent\|burst`，可选 `probability`、`burst`、`callIndex`/`position`、`seed`。未写时等同 persistent（窗口内每次命中）。 | 可复现；`intermittent` 必须带 `seed` 才能重放 |
| | 命名现场 | `scene: api_degradation\|content_filter\|max_tokens\|proxy_html\|stale_cache\|stale_data\|wrong_entity\|slow_response` | 映射到上表 action，不新增 `kind` |
| **`approval`** | `deny` | 检测到审批请求时向标准输入写入拒绝指令。 | 一次性决策 |
| | `drop` | 丢弃审批请求，保持不回应状态。 | 持续阻塞 |
| | `delay` | 等待指定 `duration` 延迟后再写入确认通过。 | 延迟回复 |
| **`compaction`**| `interrupt` | 在上下文压缩开始瞬间杀掉进程。 | 验证重新加载时 session 是否丢失 |
| **`rule`** | `conflict` | 在 System Prompt 中注入与任务冲突的指令，测试 Agent 的指令遵循与规则防御韧性。 | `duration` 结束后恢复正常 System Prompt |
| | `evict` | 动态剔除全部或正则匹配的 System 规则，测试 Agent 失去记忆/规则约束后的行为漂移。 | `duration` 结束后恢复规则 |
| | `corrupt` | 对 System 规则中的关键限制词进行语义反转篡改。 | `duration` 结束后恢复 |
| **`context`** | `poison` | 在 Agent 历史消息序列中插入虚假的报错或伪造工具执行记录，测试 Agent 的幻觉与容错。 | 持续生效直至该轮结束 |
| | `truncate` | 强制截断历史对话记录，模拟严重的上下文突发丢失。 | `duration` 结束后恢复 |
| **`input`** | `send` / `eof` | 向 Agent 标准输入写入预设文本或提前关闭管道。 | 持续生效 |

---

## 7. 断言与可靠性评测指标

### 7.1 支持的断言列表
在 `assertions` 中配置，可使用简写字符串或对象形式：

```yaml
assertions:
  - exit_zero                         # 退出码为 0
  - exit_nonzero                      # 退出码非 0（用于预期失败场景）
  - not_timed_out                     # 未发生运行超时
  - no_orphan_process                 # 运行结束后无残留子进程或孤儿进程
  - git_lock_absent                   # .git/index.lock 已被安全释放
  - git_state_consistent              # Git 状态一致性（索引与 HEAD 可用）
  - git_worktree_clean                # 工作区 worktree 干净（无残留或锁定的工作树）
  - no_duplicate_tool_side_effect     # 无重复执行相同 toolCallId 的有害副作用
  - no_lost_tool_result               # 无未闭合的悬空工具调用（tool_started 必须有 tool_finished）
  - mcp_stdio_upstream_consistent     # MCP stdio 上游工具调用幂等且副作用隔离（无重复上游调用）
  - subagent_checkpoint_restored      # 子 Agent 崩溃后父级检查点状态一致并成功回滚/恢复
  - session_resumable                 # 会话已持久化且可正常 resume
  - session_clean_recovery            # 经历会话结构漂移后干净恢复并保持会话可用
  - desktop_screenshot_captured       # 桌面原生截图成功生成且证据文件非空
  - desktop_unresponsive_detected     # 成功探测到桌面进程 UI 挂起或冻结事件
  - resource_exhaustion_recovered     # 句柄/磁盘耗尽压力恢复后工作区文件系统探针写入读写自愈
  - remote_lease_valid                # 远端云端协调器租约有效并完成心跳同步
  - remote_reconnect_success          # 经历网络断连/租约超时后成功重连恢复
  - application_eventually_responsive # 故障恢复后 Agent 仍在持续活动或正常退出
  - task_tests_pass                   # 运行 spec.verify 中的验收测试脚本并返回 0
  - workspace_matches_expected        # 匹配 spec.expected 中指定的文件存在/内容包含规则
  - event_seen: tool_started          # 运行过程中确实捕获到了指定事件
  - file_exists: src/index.js         # 指定文件必须存在
  - file_contains: dist/bundle.js:OK  # 指定文件必须包含特定字符串
  - output_contains: "success"        # 终端标准输出包含预期字符串
  - llm_triggered                     # LLM 代理至少命中一次真实注入（过滤未触发的空跑）
```

### 7.2 报告指标

- **`recoveryRate`**：已注入故障中成功恢复的比例。
- **`mttrMs`**：从注入到恢复的平均耗时（毫秒）。
- **`stateDivergence`**：结束时状态不一致（例如 Git 锁仍存在、进程无响应、残留 worktree）。
- **`duplicateSideEffectRate`**：同一 `toolCallId` 重复执行的比例。
- **`lostToolResults`**：已开始但未结束的工具调用数量。
- **`orphanCount`**：结束后仍存活的残留进程数。
- **`reworkRatio`**：恢复后重复执行先前步骤的比例。

报告的 `risk.capabilities` 会逐项记录 `ok`、`degraded` 或 `unsupported`；它描述实验前置能力，不等同于 Agent 最终通过或失败。

---

## 8. Suite 与 Workflow

### 8.1 Suite

```yaml
# examples/suites/zcode.yaml
apiVersion: agentchaos.dev/v1alpha1
kind: Suite
metadata:
  name: zcode
spec:
  repeat: 1
  workloads:
    - workloads/zcode.yaml
  profiles:
    - profiles/process/kill.yaml
    - profiles/llm/429.yaml
```
执行：`agentchaos suite examples/suites/zcode.yaml`。同一故障配置用于多个 Agent 时，见 `examples/suites/cli-agents.yaml`。`--repeat N` 要求连续 N 次通过。

### 8.2 Workflow

按 `serial`（串行）或 `parallel`（并行）编排多份实验：
```yaml
# examples/workflows/workflow.yaml
apiVersion: agentchaos.dev/v1alpha1
kind: Workflow
metadata:
  name: continuous-stress-workflow
spec:
  failFast: true                        # 设为 false 可在步骤失败后继续执行后续步骤
  tasks:
    - serial:
        - ../probe/disk-stress.yaml
        - ../probe/git-worktree.yaml
    - parallel:
        - ../probe/anthropic-messages.yaml
        - ../probe/mcp-stdio.yaml
```
执行命令：`agentchaos workflow examples/workflows/workflow.yaml`。

---

## 9. 报告

每次运行的结果位于 `.agentchaos-runs/<run-id>/`：

- **`report.html`**：分数、检查项与时间线。计划中的故障未注入（例如登录失败、进程提前退出）记为 **inconclusive**。
- **`report.json`**：供 CI 读取。
- **`report.md`**：便于附在 Pull Request 中。
- **`events.jsonl`**：按时间记录的事件。

Suite / Workflow 另有汇总报告。`view` 首页按任务列出，其下为各条实验。

```bash
agentchaos view --open
```

---

## 10. 工作区隔离

1. 文件变更发生在 `.agentchaos-runs/`。
2. 通过 CLI、管道与本地代理与目标 Agent 交互。
3. 结束时释放文件锁、关闭代理端口、停止 helper，并检查残留进程。
