# 接入 CLI Adapter

本文档介绍如何将新的 CLI Agent 接入 AgentChaos。请先确认目标可以在隔离工作区中以非交互方式启动，再选择 `generic-cli` 或具名 adapter。故障注入、进程树与断言由 runner / helper 负责，adapter 只负责启动参数。

运行现有实验见 [用户手册](./user-guide.md)。分层见 [开发者手册](./developer-guide.md)。

## 1. 选择接入方式

| 情况 | 做法 |
| --- | --- |
| 验证该 CLI 能否被终止进程、被外部改文件 | YAML 中使用 `adapter: generic-cli`，并指定 `executable` 与 `args` |
| 希望 `setup` 能够发现该 CLI，YAML 只写 `prompt` / `sandbox` | 在 TypeScript 中增加具名 adapter（对照 Codex、ZCode） |
| 桌面窗口、点击、UAC | 尚未实现，不属于 CLI adapter |

Claude / Kimi 已按无界面参数拼接（`--print`、JSON、审批绕过、`--resume`）。完整对照仍以 Codex 和 ZCode 为准；新 CLI 先 `generic-cli` 再具名 adapter。

## 2. 启动过程

`planLaunch()` 返回 `{ executable, args, env, capabilities }`。随后：

- `cwd` 是本次隔离工作区（`fixture` 复制进去），不是用户当前仓库
- `stdin` 默认是管道（可被 `input.send` 写入）。`target.pty: true` 时走 helper `pty-spawn`（Unix PTY / Windows ConPTY）；helper 没有 `pty` 能力则降级为管道并标记 degraded
- 环境是 `process.env` 再叠 `plan.env`（代理、`AGENTCHAOS_*`、adapter 自己加的变量）
- 超时、取消、`process.kill` 走 helper 杀进程树（Unix 信号 / Windows Job Object）
- stdout 里一整行 `{...}` 会记成 `agent_event`；能识别的会再写成 native 事件（`tool_started` / `approval_requested` / `compaction_started` 等），并带上 `toolCallId`。`faults[].when` 按这些事件注入。session id 仍用于 resume

目标 CLI 需满足：

1. **非交互**：一次 prompt 执行完毕，或持续运行直至被终止。
2. **使用 `cwd`**：在当前工作目录读写。
3. **以 `executable` + `args` 启动**：不使用仅适用于 POSIX shell 的 `command:`。
4. **可关闭审批**：否则实验会停在确认步骤。

有 NDJSON / `--json` 更好，但不是硬条件。没有 JSON 时，断言仍可用退出码、文件、`fault_injected`。

## 3. 使用 generic-cli 验证

无需修改 TypeScript。规格跨平台共用：

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
5. 需要 session 续跑时，在 `applyResumeArgs()` 里改 argv（Codex：`exec resume --last`；ZCode / Claude / Kimi：`--resume <id>` 或 `--continue`）。
6. `validateExperiment`：若默认启动依赖 prompt，缺 prompt / args / executable 时报错。
7. 若该 agent 假定工作区是 git 仓库，把 `normalizeSpec` 里默认 `git: true` 的 adapter 列表加上它。
8. `.cjs` / `.mjs` / `.js` 用 `node`（`process.execPath`）启动，不要在 Windows 上直接 spawn 脚本。
9. **不要在 adapter 里注入故障。** 故障只走 `faults.ts` + helper。
10. 控制面测试只断言 argv / 发现逻辑，不要登录真实模型。真实 CLI 用 `examples/` 手工或本机跑。

### 4.2 现有对照

| | Codex | ZCode | Claude | Kimi | `generic-cli` |
| --- | --- | --- | --- | --- | --- |
| 发现 | `CODEX_BIN`、ChatGPT.app、Windows 安装目录、`PATH` | `ZCODE_BIN`、`ZCode.app/.../glm/zcode.cjs`、Windows `resources\glm\zcode.cjs`、`PATH` | `CLAUDE_BIN`、npm 全局、`PATH` | `KIMI_BIN`、npm 全局、`PATH` | YAML 写死 |
| 无 TUI | `codex exec --json --ephemeral` | `--prompt --json --no-color` | `--print --output-format stream-json` | `--print --output-format json` | 你自己的 args |
| 权限 | `-s` sandbox；`bypassApprovals` | `--mode` plan / build / yolo | `--dangerously-skip-permissions` / `--permission-mode` | `--yolo` | 写在 args 里 |
| 续跑 | `exec resume --last`（需 `ephemeral: false`） | `--resume` / `--continue` | `--resume` / `--continue` | `--resume` / `--continue` | 无 |
| 登录配置 | 用户本机 Codex 登录 | `ZCODE_API_KEY`、`ZCODE_BASE_URL`、`ZCODE_MODEL`。已经设过 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 的，可以沿用 | 用户本机 Claude 登录 | 用户本机 Kimi 登录 | `target.env` |

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

`pty: true` 走 helper `pty-spawn`（Unix PTY / Windows ConPTY）；helper 没有 `pty` 能力则降级为管道并在风险预览里标 `degraded`。

## 5. 示例与文档

每个具名 adapter 的产品实验应覆盖真实工作循环。对照 [scenarios.md](./scenarios.md)：失败测试与进程中断后恢复、外部修改正在编辑的文件、Git lock。Node 替身仅用于控制面测试。

同步改：

- [user-guide.md](./user-guide.md)：发现顺序、`*_BIN`、怎么跑示例（Windows 与 macOS 分开写）
- 本页对照表
- `packages/runner/test/control-plane.test.ts`：`planLaunch` 的 argv（不调用模型）

不要把 token、session、真实用户路径写进仓库。运行时读用户本机配置可以，但不要把密钥打进 `agent_started` 的 argv 日志。

## 6. 验收

**Windows**

```bat
.\agentchaos.cmd validate examples\<name>-process-kill.yaml
```

**macOS / Linux**

```bash
./agentchaos validate examples/<name>-process-kill.yaml
```

本机已安装时，`discoverAgents()` 里该 adapter 的 `present` 应为 `true`。再跑 process-kill / file-edit，报告里 `fault_injected` 与 `no_orphan_process` 通过即可。

网络类故障还要求该 CLI 走 `HTTP(S)_PROXY`。做不到就不要在示例里写 `network.*`，或接受 `degraded`。
