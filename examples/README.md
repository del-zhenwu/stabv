# 示例

安装包与本仓库中的示例文件组织如下。首次运行使用 `examples/zcode.yaml`。

## 安装与首次运行

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

`examples/zcode.yaml` 指定 adapter 为 zcode，`inject` 覆盖安装包中的全部故障类。`fixture: broken-sum` 指向 `examples/fixtures/broken-sum/`，其中 `src/sum.js` 故意算错。测试自己的代码时，将 `fixture` 改为绝对路径。测试其他 Agent 时，复制该文件并修改 `adapter`。

不接真实模型、只检查 CLI 能否跑通：

```bash
agentchaos run examples/probe/codex-smoke.yaml
```

可执行文件不在 `PATH` 中时，请设置 `ZCODE_BIN`、`CODEX_BIN`、`CLAUDE_BIN` 或 `KIMI_BIN`。ZCode 填写三项：`ZCODE_API_KEY`、`ZCODE_BASE_URL`、`ZCODE_MODEL`。已经设过 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 的，可以沿用。

从本仓库源码开发时，请使用 `scripts\setup.cmd` 或 `./scripts/setup.sh`。

## 目录

| 路径 | 说明 |
| --- | --- |
| `zcode.yaml` | 用户入口：ZCode × 全部故障类 |
| `fixtures/` | 示例项目。`broken-sum` 对应 prompt 中的 `src/sum.js` |
| `probe/` | 使用 Node 替身的控制面探测，无需登录真实 Agent |
| `workloads/` | 各 Agent 的启动配置 |
| `profiles/` | 单条故障配置 |
| `suites/` | 批量实验 |
| `workflows/` | 串行或并行的多步编排 |

日常用 `examples/zcode.yaml`。`workloads/` 与 `profiles/` 由系统展开组合时使用。

限定故障条目：

```yaml
inject:
  llm: [429, 500]
  resource: cpu
```

同一轮同时注入多类故障时，设置 `together: true`。

命令与字段见 [用户手册](../docs/user-guide.md)。场景对照见 [scenarios.md](../docs/scenarios.md)。
