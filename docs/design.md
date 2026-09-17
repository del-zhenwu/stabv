# AgentChaos 设计文档

## 背景

Coding agent、研究 Agent、办公 Agent、浏览器 Agent 和自动化 Agent 都已经是长时、多轮、工具驱动的软件系统。Codex、Claude Code、Kimi Code、ZCode、Cursor、Zed/ACP 是当前最适合验证的第一批对象，但问题本身不限于代码生成。传统只检查最终产物的 benchmark 无法解释客户端 crash、操作卡死、session 丢失、工具重复执行、上下文压缩退化和跨平台权限问题。

AgentChaos 的目标是建立类似 Chaos Mesh 的实验平台，把被测对象定义为：

```text
模型 + agent harness + tool/MCP + 执行环境 + 状态存储 + OS + desktop UI
```

## 用户配置与报告

用户在一份 YAML 中声明目标 Agent 与故障类别（`target.adapter` + `inject`）。系统展开组合。报告首先展示该组合，再列出各条结果。`workloads/` 与 `profiles/` 为内部目录。

## 目标

- 测量运行时可靠性、恢复能力和最终状态一致性。
- 黑盒优先，兼容 CLI 和桌面客户端。
- 同一 workload/profile 可比较 coding、研究、办公、浏览器和自动化 Agent。
- 支持 Mac/Windows，并把桌面权限隔离到最小权限 helper。
- 让长时任务、组合故障和中断恢复成为可重复实验。

## 评测范围

评测对象是 Agent 在故障与长任务中的系统行为：运行时可靠性、恢复能力与最终状态一致性。能力类 benchmark（例如 SWE-bench）与模型生成质量本身不作为唯一目标。时间维度使用事件压缩（工具次数、压缩次数、断连次数）。

## 边界

- 编排只在 TypeScript 控制面；Rust helper 和桌面 bridge 不编排实验。
- Python 只做离线分析，不是生产 runner。
- 不默认向真实用户主目录或未 opt-in 的危险命令注入故障。
- 不伪造杀毒软件拦截；权限场景只走系统 API，且必须用户 opt-in。

## 三类故障

测试时必须分开统计，否则大量「看起来像模型不行」的问题其实是 harness 缺陷：

1. **进程崩溃**：进程退出、无响应、渲染进程挂掉、子进程泄漏、资源耗尽。
2. **操作卡死**：进程还在，但无法继续——审批弹不出来、流式输出停住、取消无效、session 恢复失败。
3. **语义分叉**：应用没崩，但状态不可恢复——同一命令执行两次、tool 结果错配、压缩后丢掉约束、显示完成但测试没过、agent / harness / 文件 / Git 四个视图不一致。

## 选择 Harness Chaos 还是桌面端 Chaos

先问被测系统的边界在哪里：如果验收对象是「agent 如何处理模型、工具、shell、文件和 Git」，使用 Harness Chaos；如果验收对象包含「用户如何通过窗口操作 agent，以及桌面进程如何与系统权限、睡眠、更新和渲染器交互」，才使用桌面端 Chaos。两者不是两个互斥产品，而是从内到外的两层测试。

| 问题 | 首选 Harness Chaos | 必须增加桌面端 Chaos |
| --- | --- | --- |
| Codex/Claude/Kimi CLI 是否能恢复 | 是 | 否 |
| tool call、MCP、shell、PTY、Git、文件状态 | 是 | 否 |
| 网络、LLM API、上下文压缩、重试 | 是 | 否 |
| agent 进程树、孤儿进程、端口、资源 | 是 | 否 |
| 审批弹窗是否出现、关闭后状态是否正确 | 否 | 是 |
| 输入框、快捷键、输入法、拖拽、焦点 | 否 | 是 |
| Electron/webview/renderer crash | 否 | 是 |
| Mac TCC、Windows UAC/ACL/Defender 交互 | 否 | 是 |
| 睡眠唤醒、显示器拔插、自动更新 | 否 | 是 |
| 用户看到的「卡死」和 UI 恢复 | 只能间接判断 | 是 |

### 先做 Harness Chaos 的情况

- 产品有 CLI 或非交互模式，这是 Codex、Claude Code、Kimi Code、ZCode 最稳定的测试入口。
- 需要比较不同 agent 或不同模型，必须先把 UI 变量去掉。
- 问题表现为工具重复、session 丢失、上下文压缩错误、Git/workspace 不一致、网络恢复失败。
- 需要在 CI、批量 Suite、`pass^k` 或长时 endurance 中重复运行。

Harness Chaos 的验收重点是：最终测试结果、session 是否能继续、工具副作用是否重复、workspace/Git 是否一致、进程树是否清理。它回答「agent harness 是否可靠」。

### 需要桌面端 Chaos 的情况

- CLI 测试通过，但用户仍然遇到窗口无响应、审批不出现、输入失效或流式区域停止刷新。
- 故障只可能发生在桌面生命周期：sleep/wake、renderer crash、自动更新、显示器/DPI 变化、窗口关闭、浏览器 OAuth 回调。
- 产品的真实工作入口只有桌面 App，CLI 并不共享相同的 session、权限或进程架构。
- 需要验证 TCC/UAC/ACL、Accessibility、Screen Recording、系统代理或网络扩展等 OS 集成。

桌面端 Chaos 的验收重点是：窗口是否仍可操作、用户输入是否到达正确 session、审批状态是否一致、renderer/agent/backend 是否能恢复、系统权限变化是否被正确处理。它回答「用户实际接触到的桌面产品是否可靠」。

### 推荐的测试顺序

```text
Harness baseline
→ Harness fault injection
→ Harness recovery / replay
→ 跨平台 CLI 对比
→ 桌面 smoke（窗口、输入、审批）
→ 桌面故障（renderer、sleep/wake、权限、更新）
→ Harness + 桌面组合故障
```

桌面自动化会引入焦点、渲染、时序和权限变量，失败后难以归因。桌面测试应由已在 Harness 层稳定复现、或明确属于 UI/OS 的场景触发。

### 如何判断一个失败属于哪一层

同一 workload 至少跑两次：一次走 CLI/Harness，一次走桌面入口。若两者在相同故障下都失败，优先归因 harness、模型协议或工具；若 CLI 通过而桌面失败，优先归因 UI、桌面进程、权限或桌面到 harness 的桥接；若只有特定 OS 失败，归因对应平台 helper 或系统 API。报告必须保留这三个维度：`agent/harness`、`workspace/process`、`desktop/os`。

## 设计原则

1. 黑盒优先，原生事件可选。
2. 控制面与执行面分离。
3. 工作负载与故障 profile 解耦。
4. 故障、恢复、验证必须成对出现。
5. 事件溯源、可重放、可中断、幂等。
6. 能力发现，不支持的能力标记为 unsupported/degraded。
7. 最小权限，控制面不默认以管理员运行。
8. 以最终状态和不变量判断成功，而不是文本相似度。
9. 故障、恢复、验证成对出现；进程重新启动不算恢复成功。
10. 单项故障往往复现不了生产问题；组合故障（长任务 + 网络 + 压缩、kill + git lock、外部改文件 + 正在 patch）才是默认回归对象。

## 参考对象

- Chaos Mesh：CRD、独立 controller、daemon、workflow、scheduler、duration/recovery。
- ReliabilityBench：`pass^k`、语义扰动和工具/API fault tolerance。
- AgentChaos：LLM API fault proxy。
  - harnessbench、coding-agent-eval-harness：固定模型比较 coding harness、hidden grader、可中断继续和 telemetry；方法可推广到其它工具型 Agent。
- Coding-Agent Harness Study：长任务 kill/resume 与 rework。
- Codex/Claude/Kimi/ZCode/Zed：审批、sandbox、hooks、MCP、subagent、session 和 ACP。

## 故障范围

客户端/UI、LLM/API、网络、权限审批、上下文压缩、shell/PTY、MCP/subagent、进程生命周期、文件/Git、磁盘/内存、睡眠唤醒、自动更新，以及这些故障的组合。

## 产品形态

**当前主入口**是 npm 包 `agentchaos`：本机 CLI、YAML 与 `agentchaos view`。故障注入发生在本机 Agent 进程。

以后可以加其它入口，但必须共用同一套 runner 语义（只调 API，不直接控目标进程）：

- **Dashboard**：Targets / Workloads / Chaos Profiles / Run 时间线 / Result / Evidence / Replay
- **YAML 实验编辑器**：运行前 schema、权限、风险检查（现在是 `validate` 打 JSON）
- **可复用的 CI runner**：GitHub Action、退出码契约、报告上传、macOS + Windows 矩阵。仓库自己的 CI 不是对外产品。
- **稳定 HTTP/WebSocket runner API**
- **预编译 helper**：npm 包必须自带 `prebuilt/darwin-arm64`、`darwin-x64`、`win32-x64`。缺一个就不能发。用户装包没有 fallback，也不装 Rust。`cargo` 只给改本仓库的人用

桌面 helper 只提供 UI、进程、网络和系统事件，不编排实验。页面划分和用户流程见文内「面向用户的交互界面」。能力缺口（PTY、MCP、endurance 等）见 [roadmap.md](./roadmap.md)，不在路线图里再列一份包装待办。

## 成功定义

```text
应用最终可操作
+ session 可继续
+ 没有重复工具副作用
+ workspace/Git 状态一致
+ 子进程已清理
+ 任务验证通过
```

恢复要分四层，不能只看进程是否起来：

1. **故障恢复**：网络已通、锁已解开、进程已重启
2. **任务恢复**：同一 session 能继续，用户不必重讲任务
3. **副作用恢复**：没有重复命令、重复 patch、重复提交
4. **状态恢复**：agent / harness / 文件系统 / Git 一致

产品实验写不变量（`no_orphan_process`、`git_state_consistent`、`no_duplicate_tool_side_effect`、`session_resumable`），不要用「等 N 秒」当工作负载。

## 路线

MVP（已具备）：进程 kill、文件外部编辑、时间调度、事件日志和断言、CLI + 本地 viewer。

后续**能力**按主题列在 [roadmap.md](./roadmap.md)，不绑定时间点。Dashboard、CI Action、npm 属于上面的产品形态，不是路线图条目。

## 技术选型建议

采用 **TypeScript control plane/runner + Rust 跨平台 helper**。TypeScript 适合实验编排、协议代理、adapter 和报告生态；Rust 适合长期运行的进程监督、PTY/ConPTY、资源控制和平台原语。Rust 是执行 OS 原语的边界组件，不负责编排实验、解析 YAML 或构造 Codex argv。

推荐分层：

- **TypeScript control plane/runner**：实验解析、Codex adapter、workflow、状态机、事件日志、恢复、断言。
- **Rust helper**：进程树、PTY/ConPTY、workspace/Git 低层控制和跨平台清理。
- **Mac helper**：Rust 主体 + 少量 Swift/Objective-C bridge，处理 Accessibility、TCC、Screen Recording、睡眠唤醒等系统 API。
- **Windows helper**：Rust 主体 + 少量 Windows API/COM bridge，处理 UI Automation、Job Object、ConPTY、ACL/UAC。
- **Dashboard**：TypeScript + React；通过本地 HTTP/WebSocket 连接 Rust daemon。
- **实验文件**：YAML/JSON，schema 公开并版本化。

Python 适合早期原型、离线分析和报告生成；TypeScript 适合控制面、网络协议和 Node agent adapter。Rust 专注于进程监督、PTY/ConPTY 和平台 helper。这个分层兼顾生态接入速度、跨平台低层能力和长期维护性。

## 面向用户的交互界面

用户不应该直接理解 controller、daemon 或 fault injector。产品应提供三种入口：

1. **CLI**：开发者和 CI 使用，支持 `init`、`run`、`replay`、`report`、`recover`。
2. **桌面 Dashboard**：测试工程师选择 agent、workspace、workload 和 chaos profile，查看实时状态和证据。
3. **实验文件编辑器**：高级用户可直接编辑 YAML，并在运行前获得 schema、权限和风险检查。

Dashboard 的核心页面：

- **Targets**：已发现的 Codex/Claude/Kimi/ZCode/桌面 agent，显示版本、平台和能力。
- **Workloads**：任务仓库、prompt、验证命令、隔离方式。
- **Chaos Profiles**：网络、进程、文件、Git、资源、桌面故障及组合 workflow。
- **Run**：时间线显示 agent 状态、故障注入、审批、tool、进程和恢复事件。
- **Result**：最终断言、恢复耗时、重复副作用、孤儿进程、workspace/Git diff。
- **Evidence**：事件日志、脱敏终端输出、截图、crash dump、环境信息。
- **Replay**：选择某个 run，修改一个故障参数后重新执行。

用户流程应是：

```text
发现被测 agent
→ 选择或创建 workload
→ 选择 chaos profile
→ 预览权限和影响范围
→ 启动实验
→ 查看实时时间线
→ 检查最终断言和证据
→ 一键 replay 或导出报告
```

界面应把实验分成“任务”“故障”“恢复”“验证”四块，而不是暴露底层进程信号和 proxy 规则。高级模式再显示 event id、tool call、session revision 和进程树。

桌面权限首次使用时采用向导：明确说明需要的 Mac/Windows 权限、用途、有效范围和撤销方式；没有权限时允许降级为 CLI/网络/文件测试，并清楚显示覆盖范围，不阻塞全部功能。
