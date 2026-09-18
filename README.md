# AgentChaos

AgentChaos 是面向本机 Coding Agent 的故障注入 CLI。

按 YAML 指定目标 Agent 与故障类型，在隔离工作区中注入进程、文件、Git、网络与模型接口故障，并用本地报告核对结果。

## 功能

- **故障覆盖：** 进程、子 Agent、会话、文件、Git、网络、模型接口、MCP、资源、审批、上下文压缩。
- **一份 YAML：** 写 `target.adapter` 和 `inject`，系统展开组合。macOS 与 Windows 10+ 使用同一份配置。
- **隔离执行：** 实验在 `.agentchaos-runs/` 中运行，不修改当前目录。安装包已包含各平台 helper，只需 Node.js 22+。
- **本地报告：** `agentchaos view` 查看每次注入的结果。

默认 `inject` 是安全的常用故障集（LLM、资源、文件、Git、网络、进程），MCP、桌面、会话、子 Agent、远程和认知故障需要在 YAML 中显式选择。

## 快速开始

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

```yaml
# examples/zcode.yaml（安装包自带，adapter 固定 zcode）
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

`inject` 展开为安装包中对应类别的全部故障。换 Agent 时复制该文件并改 `adapter`。`broken-sum` 是自带示例（`src/sum.js` 实现有误）；测自己的工程时把 `fixture` 写成绝对路径。二进制不在 `PATH` 时设置 `ZCODE_BIN`。

第一次遇到具体问题时，先查 [场景→故障映射](docs/scenarios.md)，不必先阅读完整故障目录。

跑 ZCode 前填写三项：API Key、网关地址、模型名。

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

已经设过 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 的，可以沿用，不必再写一遍。

不接真实模型、只检查 CLI 能否跑通：

```bash
agentchaos run examples/probe/codex-smoke.yaml
```

## 文档

总览：[docs/README.md](docs/README.md)

- **使用与评测：** [用户手册](docs/user-guide.md) · [示例](examples/README.md) · [场景表](docs/scenarios.md)
- **开发与扩展：** [开发者手册](docs/developer-guide.md) · [对接 CLI Adapter](docs/cli-adapter.md) · [技术说明](docs/technical.md) · [设计](docs/design.md)
- **仓库协作：** [AGENTS.md](AGENTS.md) · [协作指南](docs/agent-guidelines.md) · [Roadmap](docs/roadmap.md)
