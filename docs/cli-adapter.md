# 对接新的 CLI

把一个新的 coding agent 接到 AgentChaos：先确认它能在隔离工作区里无界面启动，再决定用 `generic-cli` 还是写具名 adapter。故障注入、进程树、断言仍由 runner / helper 负责，adapter 只负责「怎么启动」。

用户怎么跑现有实验见 [user-guide.md](./user-guide.md)。分层边界见 [developer-guide.md](./developer-guide.md)。

## 1. 选哪条路

| 情况 | 做法 |
| --- | --- |
| 只想验证这个 CLI 能不能被杀进程、被改文件 | YAML 里 `adapter: generic-cli`，写死 `executable` + `args` |
| 希望 `setup` 能发现它，YAML 只写 `prompt` / `sandbox` | 在 TypeScript 里加具名 adapter（对照 Codex、ZCode） |
| 桌面窗口、点击、UAC | 还没有；不要做成 CLI adapter |

Claude / Kimi 目前只是按 `PATH` 找同名二进制，没有拼真实参数。不要把它们当完整范例。完整范例是 Codex 和 ZCode。

## 2. Runner 会怎么启动

`planLaunch()` 返回 `{ executable, args, env, capabilities }`。随后：

- `cwd` 是本次隔离工作区（`fixture` 复制进去），不是用户当前仓库
- `stdin` 默认是管道（可被 `input.send` 写入）。`target.pty: true` 时走 helper `pty-spawn`（Unix PTY / Windows ConPTY）；helper 没有 `pty` 能力则降级为管道并标记 degraded
- 环境是 `process.env` 再叠 `plan.env`（代理、`AGENTCHAOS_*`、adapter 自己加的变量）
- 超时、取消、`process.kill` 走 helper 杀进程树（Unix 信号 / Windows Job Object）
- `stdout` 里一整行 `{...}` 会记成 `agent_event`；从中读 `sessionId` / `thread_id` / `toolCallId`，给 resume 和重复 tool 断言用

因此目标 CLI 至少要能：

1. **无 TUI**：一次 prompt 跑完或一直跑到被杀，不要默认全屏交互
2. **认 `cwd`**：在当前工作目录读写，不要写回用户主目录
3. **可被非交互拉起**：`executable` + `args`，不要依赖 bash 专用的 `command:`（Windows 会失败）
4. **审批可关**：否则实验会卡在确认框里（管道接不住 TUI）

有 NDJSON / `--json` 更好，但不是硬条件。没有 JSON 时，断言仍可用退出码、文件、`fault_injected`。

## 3. 先用 generic-cli 试通

不改 TypeScript。规格跨平台共用：

```yaml
apiVersion: agentchaos.dev/v1alpha1
kind: Experiment
metadata:
  name: my-cli-process-kill
spec:
  target:
    adapter: generic-cli
    executable: my-agent
    args:
      - --print
      - "List files in this directory, then wait 30 seconds. Do not modify files."
      - --json
    env:
      MY_AGENT_HOME: /path/if/needed
  fixture: mini-js
  timeout: 15s
  faults:
    - type: process
      action: kill
      at: 500ms
  assertions:
    - exit_nonzero
    - no_orphan_process
    - fault_injected:process.kill
```

二进制不在 `PATH` 时，`executable` 写成绝对路径。`.cjs` / `.js` 不要假设 Unix shebang 在 Windows 上可用，改成 `executable: node` 加脚本路径：

```yaml
target:
  adapter: generic-cli
  executable: node
  args:
    - C:\Program Files\MyAgent\resources\cli.cjs
    - --print
    - "Inspect the workspace. Do not modify files."
```

**Windows**

```bat
.\agentchaos.cmd validate examples\my-cli-process-kill.yaml
.\agentchaos.cmd run examples\my-cli-process-kill.yaml
.\agentchaos.cmd view --open
```

**macOS / Linux**

```bash
./agentchaos validate examples/my-cli-process-kill.yaml
./agentchaos run examples/my-cli-process-kill.yaml
./agentchaos view --open
```

这一步通过，说明隔离工作区、杀树、报告链路对该进程有效。再把启动参数收进具名 adapter。

## 4. 具名 adapter 要改什么

代码都在 TypeScript 控制面，主要是 `packages/runner/src/adapters.ts`。不要在 Rust helper 里解析 YAML 或拼接 argv。

### 4.1 清单

1. `spec.ts` 的 `AdapterName` 加上名字。
2. `planLaunch` 增加分支：根据 `prompt`、`sandbox`、`json`、`bypassApprovals`、`extraArgs` 拼默认 argv。YAML 若已给 `args` 或 `command`，尊重用户覆盖。
3. 发现二进制，顺序建议：环境变量（如 `CODEX_BIN` / `ZCODE_BIN`）→ 本机安装位置 → `PATH`（Windows 含 `PATHEXT`）。
4. `discoverAgents()` 列入 `setup` / `init` 的探测结果。
5. 需要 session 续跑时，在 `applyResumeArgs()` 里改 argv（Codex：`exec resume --last`；ZCode：`--resume <id>` 或 `--continue`）。
6. `validateExperiment`：若默认启动依赖 prompt，缺 prompt / args / executable 时报错。
7. 若该 agent 假定工作区是 git 仓库，把 `normalizeSpec` 里默认 `git: true` 的 adapter 列表加上它。
8. `.cjs` / `.mjs` / `.js` 用 `node`（`process.execPath`）启动，不要在 Windows 上直接 spawn 脚本。
9. **不要在 adapter 里注入故障。** 故障只走 `faults.ts` + helper。
10. 控制面测试只断言 argv / 发现逻辑，不要登录真实模型。真实 CLI 用 `examples/` 手工或本机跑。

### 4.2 现有对照

| | Codex | ZCode | `generic-cli` |
| --- | --- | --- | --- |
| 发现 | `CODEX_BIN`、ChatGPT.app、Windows 安装目录、`PATH` | `ZCODE_BIN`、`ZCode.app/.../glm/zcode.cjs`、Windows `resources\glm\zcode.cjs`、`PATH` | YAML 写死 |
| 无 TUI | `codex exec --json --ephemeral` | `--prompt --json --no-color` | 你自己的 args |
| 权限 | `-s` sandbox；`bypassApprovals` | `--mode` plan / build / yolo | 写在 args 里 |
| 续跑 | `exec resume --last`（需 `ephemeral: false`） | `--resume` / `--continue` | 无 |
| 登录配置 | 用户本机 Codex 登录 | CLI `~/.zcode/cli/config.json`；若只有桌面登录则从 `~/.zcode/v2/config.json` 注入环境变量 | `target.env` |

LLM 代理（`llm.*` 故障）依赖进程认 `OPENAI_BASE_URL`。Codex / ZCode 的云后端可能忽略它，`validate` 会标 `degraded`。新 CLI 若也不认该变量，同样在 `previewRisk` 里注明。

### 4.3 YAML 字段（具名 adapter）

```yaml
target:
  adapter: my-agent          # 与 AdapterName 一致
  prompt: "..."              # 默认拼进 argv
  sandbox: read-only         # 映射到该 CLI 的权限模式
  json: true
  bypassApprovals: true      # 映射到 yolo / --dangerously-* 等
  extraArgs: ["--foo"]       # 追加
  executable: /override      # 可选，跳过发现
  args: ["..."]              # 可选，整段覆盖默认 argv
  env:
    MY_AGENT_BIN_HINT: "..."
```

`pty: true` 目前会降级为管道，并在风险预览里标 `degraded`。

## 5. 示例与文档

每个具名 adapter 产品实验要少，打真实工作循环。对照 [scenarios.md](./scenarios.md)：失败测试 + 杀进程 resume、外部改正在 patch 的文件、Git lock。不要写「等待 N 秒再回答」当任务。Node 替身只给控制面单测。

同步改：

- [user-guide.md](./user-guide.md)：发现顺序、`*_BIN`、怎么跑示例（Windows 与 macOS 分开写）
- 本页对照表
- `packages/runner/test/control-plane.test.ts`：`planLaunch` 的 argv（不调用模型）

不要把 token、session、真实用户路径写进仓库。运行时读用户本机配置可以，但不要把密钥打进 `agent_started` 的 argv 日志。

## 6. 验收

**Windows**

```bat
.\agentchaos.cmd setup
.\agentchaos.cmd init
.\agentchaos.cmd validate examples\<name>-process-kill.yaml
```

**macOS / Linux**

```bash
./agentchaos setup
./agentchaos init
./agentchaos validate examples/<name>-process-kill.yaml
```

`init` 输出里该 adapter 的 `present` 应为 `true`（本机已安装时）。再跑 process-kill / file-edit，报告里 `fault_injected` 与 `no_orphan_process` 通过即可。

网络类故障还要求该 CLI 走 `HTTP(S)_PROXY`。做不到就不要在示例里写 `network.*`，或接受 `degraded`。
