---
name: agentchaos-adapter-probe
description: >-
  用于 Coding Agent 对未知或定制 Coding Agent 进行逆向探针与适配规范化。提取目标 CLI 签名、环境变量注入点与会话契约，并严格分离静态逆向推断与真实混沌实验证据。
---

# AgentChaos 适配探针规范 (Adapter Probe Skill)

本 Skill 规范了 Coding Agent 在协助用户接入未知或私有 Coding Agent 时的探针与逆向工作流。

## 核心设计边界与原则

1. **职责分离**：
   - 逆向工程（反编译分析、代码审计、符号探测）是 **Coding Agent** 本身具备的智能推理能力，**AgentChaos 运行时本身不内置逆向工程引擎**。
   - AgentChaos 核心定位是**黑盒/灰盒可靠性与一致性受控实验平台**，专注于进程生命周期、网络/协议代理、文件锁与不变量断言。
2. **严禁混淆证据来源（Evidence Provenance）**：
   - `empirical`（实测硬证据）：必须来自 AgentChaos 实验在真实操作系统、真实代理或真实文件系统上运行捕获的事件。
   - `static_probe`（静态探针证据）：由 Coding Agent 通过静态代码扫描、解包反编译、AST 提取得到的配置与接口结论。
   - `agent_inference`（推断假设）：Coding Agent 根据经验做出的推断或未经验证的猜想。
   - **在任何测试报告与输出中，必须明确区分上述三者，严禁用静态推断冒充实测结果！**

---

## 适配探针标准化流程

当用户要求“测试本地某 Agent”或“接入一个新 Agent”时，Coding Agent 应遵循以下探针步骤：

### 步骤 1：定位目标可执行体与运行时结构
- 检查是二进制原生可执行文件（ELF/Mach-O/PE），还是脚本包装（Node.js `.cjs`/`.js`, Python `.py`, Shell script）。
- 探测位置优先级：系统 `PATH` -> 桌面应用 bundle（如 `/Applications/*.app/Contents/Resources/` 或 `C:\Program Files\*`）-> 用户工作区。

### 步骤 2：探测 CLI 契约与非交互参数
- 静态搜索或执行 `--help`、`-h` 查看非交互执行参数（如 `--prompt`, `-p`, `--json`, `--full-auto`, `--non-interactive`）。
- 确定输出模式：是否支持结构化输出（JSON/NDJSON/SSE 流式输出），或纯 PTY 终端渲染。

### 步骤 3：探测模型与通信代理拦截点
- 检索代码中读取环境变量的逻辑（如 `process.env.OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `*_API_KEY`）。
- 检索配置文件加载逻辑（如 `~/.config/*/config.json` 或应用专用私有数据目录）。
- 确定 Agent 使用的协议方言：
  - OpenAI `/v1/chat/completions`
  - Anthropic `/v1/messages` (SSE stream)
  - 本地 MCP stdio / JSON-RPC 2.0

### 步骤 4：生成 AgentChaos 适配规范
探针完成后，生成标准形式的声明式 YAML 配置（优先使用 `generic-cli` 或指定 adapter）：

```yaml
apiVersion: agentchaos.dev/v1alpha1
kind: Experiment
metadata:
  name: <target-agent>-smoke
spec:
  target:
    adapter: generic-cli
    executable: "<target_bin_path>"
    args:
      - "--prompt"
      - "Fix the bug in src/index.js"
      - "--json"
    env:
      # 将 LLM 流量透明定向至 AgentChaos LlmProxy
      ANTHROPIC_BASE_URL: "http://127.0.0.1:__AGENTCHAOS_LLM_PORT__"
      ANTHROPIC_API_KEY: "agentchaos-probe-test"
  timeout: 30s
  faults: []
  assertions:
    - not_timed_out
    - no_orphan_process
```

### 步骤 5：交由 AgentChaos 执行真实实验验证
- 探针得到的仅仅是 `static_probe`。
- 调用 `./agentchaos run <spec.yaml>` 执行实际受控实验，生成具备 `[EMPIRICAL]` 证据标注的正式报告。
