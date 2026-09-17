# Coding Agent 协作指南

本文档约定如何使用 AI 编程助手在本仓库中继续开发 AgentChaos。

---

## 1. 分层

控制面与执行面分离：

```text
┌────────────────────────────────────────────────────────┐
│  TypeScript 控制面 (packages/runner)                   │
│  · YAML 解析、校验、反序列化                           │
│  · 实验工作流调度（串行/并行/重试）                    │
│  · HTTP / SSE 代理（OpenAI / Anthropic / MCP）         │
│  · 事件流分类 (native-events) 与指标计算 (metrics)      │
│  · CLI 命令行入口与本地 Viewer 报告生成                │
└──────────────────────────┬─────────────────────────────┘
                           │ TypeScript 仅通过 HelperClient 调用
                           │ 不直接 kill(-pid) 或解析 ps
                           ▼
┌────────────────────────────────────────────────────────┐
│  Rust Platform Helper (helper/)                        │
│  · 跨平台进程树发现与原子销毁 (Job Object / SIGKILL)    │
│  · 进程挂起与恢复 (SuspendThread / SIGSTOP)            │
│  · 跨平台虚拟终端 (Unix PTY / Windows ConPTY)           │
│  · 原生文件排他锁 (flock / LockFileEx) 与权限映射      │
│  · 物理资源压力 (CPU / 内存 / 磁盘压力填充)            │
└────────────────────────────────────────────────────────┘
```

### 约束
1. **Helper 不编排实验**：输入结构化命令，输出 JSON 或 stderr 握手。不在 Rust 中解析 YAML、拼装特定 Agent 参数或决定何时注入故障。
2. **TypeScript 不直接操作 OS 进程树**：不调用 `process.kill(-pid)`、不解析 `ps -ef`、不通过 shell 调用 `taskkill` / `wmic`。进程树与文件锁通过 `HelperClient` 完成。

---

## 2. 跨平台第一原则：Windows 10+ 与 macOS 平等优先

AgentChaos 的核心竞争力之一是**同一份实验 YAML 在 macOS 和 Windows 10+ 上无缝运行**。

- **禁止默认写 Unix Bash**：规格中的 `target` 优先使用 `executable` + `args`，避免使用 POSIX 特有的 `command:`。
- **文档说明必须双平台平权**：在 README 或用户说明中，安装与运行必须分别为 Windows（`scripts\setup.cmd` / `.\agentchaos.cmd`）与 macOS（`./scripts/setup.sh` / `./agentchaos`）提供独立的 3 行代码块，**禁止**写成一行 Unix 命令后面跟 `# Windows 下请自行修改...`。
- **Helper 必须双平台实现**：在 Helper 中增加任何系统能力时，必须同时提供 Unix 和 Windows 10+ 原生 API 实现（Unix 信号 vs Windows Job Object/Thread 挂起；flock vs LockFileEx）。

---

## 3. 真实性与测试不变量原则

AgentChaos 测量的是**Agent 在混乱条件下的不变量**，而不是模型生成文本的质量。

1. **拒绝假恢复与假通过**：
   - 进程存活不等于任务恢复；故障消除不等于副作用一致。
   - 必须通过 `shadow_compare`、文件系统 hash、Git lock 状态、孤儿进程检查、工作区预期文件来进行硬核验证。
2. **拒绝使用 `sleep N 秒` 作为测试通过标准**：
   - 产品级样例先写用户怎么用：`target.adapter` + `inject`，再驱动 Agent 在真实坏代码 fixture 上修代码、跑测试。目录分层是给系统扩的，不要让用户填交叉表。
   - 只有内部控制面单元测试允许使用快速 Node stub。
3. **隔离优先与严禁侵入用户主目录**：
   - 所有实验必须在 `.agentchaos-runs/<runId>/work/` 隔离副本中进行，严禁向用户的真实项目目录或系统主目录注入破坏性故障。
   - 不要伪造杀毒软件或虚构不可控的系统行为。

---

## 4. 依赖顺序驱动（Roadmap 推进次序）

当被要求增加新特性或推进路线图时，遵循固定的依赖推进次序：

```text
第 1 步：编写 YAML 示例与预期行为（先定义用户如何写、怎么断言）
   ↓
第 2 步：实现或扩展断言逻辑 (assertions.ts) 与指标统计 (report.ts)
   ↓
第 3 步：如涉及系统级能力，在 Rust Helper 中增加对应命令及 IPC 封装
   ↓
第 4 步：最后在 runner.ts / faults.ts 中串联调度与恢复机制
   ↓
第 5 步：补充 control-plane.test.ts 自动化测试并运行通过
```

---

## 5. TypeScript 与 Rust 编码规范

### TypeScript (`packages/runner`)
- 运行时：纯 Node.js，通过 `node --experimental-strip-types` 执行，禁止增加额外复杂打包编译链。
- **禁止使用构造函数参数属性**（如 `constructor(private foo: string)`），必须显式声明字段并赋值。
- **禁止在同一表达式中混用 `??` 与 `||`**，若混用必须加明确的括号。
- 保证测试环境独立：控制面自动化测试（`npm test`）**严禁依赖任何真实的云端 LLM Key 或外部登录**，全部使用内置的 `LlmProxy`、`McpProxy` 或进程 Mock 跑通。

### Rust (`helper/`)
- 错误处理：使用 `anyhow::Result`。
- 结构化输出：统一向 stdout 打印一行 JSON (`print_json(...)`)；失败时退出码非 0 并输出结构化 JSON 错误。
- 纯安全子命令：保持 `agentchaos-helper` 的子进程独立运行与超时自动回收。

---

## 6. 变更提交 Checklist

在交付代码变更前，必须依次确认：
- [ ] `cargo check -p agentchaos-helper` 与 `cargo test -p agentchaos-helper` 编译并通过。
- [ ] `npm test` 完整控制面测试全部通过（当前为 56+ 个测试用例）。
- [ ] 新增的 YAML 实验通过 `./bin/agentchaos.js validate <spec.yaml>` 校验，并通过 `--dry-run` 测试。
- [ ] 相关用户文档（`docs/user-guide.md`）、场景对照表（`docs/scenarios.md`）已更新为中文规范表达。
- [ ] 没有引入 Unix 专用假设，Windows 脚本与命令格式保持一致。
