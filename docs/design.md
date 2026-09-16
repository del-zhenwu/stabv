# AgentChaos 设计文档

## 背景

Codex、Claude Code、Kimi Code、ZCode、Cursor、Zed/ACP 及工作类 agent 已经是长时、多轮、工具驱动的软件系统。传统只检查最终代码的 benchmark 无法解释客户端 crash、操作卡死、session 丢失、工具重复执行、上下文压缩退化和跨平台权限问题。

AgentChaos 的目标是建立类似 Chaos Mesh 的实验平台，把被测对象定义为：

```text
模型 + agent harness + tool/MCP + shell/PTY + workspace/Git + OS + desktop UI
```

## 目标

- 测量运行时可靠性、恢复能力和最终状态一致性。
- 黑盒优先，兼容 CLI 和桌面客户端。
- 同一 workload/profile 可比较 Codex、Claude、Kimi、ZCode 等 agent。
- 支持 Mac/Windows，并把桌面权限隔离到最小权限 helper。
- 让长时任务、组合故障和中断恢复成为可重复实验。

## 不测什么

AgentChaos 不替代 SWE-bench 等能力 benchmark，也不把模型生成质量本身当作唯一目标；它关注 agent 在故障和长轨迹中的系统行为。堆更多复杂评测题、空等几小时，通常也复现不了 harness 问题。应用事件压缩（工具次数、压缩次数、断连次数）而不是墙钟。

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
- harnessbench、coding-agent-eval-harness：固定模型比较 harness、hidden grader、可中断继续和 telemetry。
- Coding-Agent Harness Study：长任务 kill/resume 与 rework。
- Codex/Claude/Kimi/ZCode/Zed：审批、sandbox、hooks、MCP、subagent、session 和 ACP。

## 故障范围

客户端/UI、LLM/API、网络、权限审批、上下文压缩、shell/PTY、MCP/subagent、进程生命周期、文件/Git、磁盘/内存、睡眠唤醒、自动更新，以及这些故障的组合。

## 产品形态

**当前主入口**是 CLI + YAML + 本地 HTML viewer：`./agentchaos` / `.\agentchaos.cmd`，报告用 `view`。不要把桌面应用做成主界面。

以后可以加其它入口，但必须共用同一套 runner 语义（只调 API，不直接控目标进程）：

- **Dashboard**：Targets / Workloads / Chaos Profiles / Run 时间线 / Result / Evidence / Replay
- **YAML 实验编辑器**：运行前 schema、权限、风险检查（现在是 `validate` 打 JSON）
- **可复用的 CI runner**：GitHub Action、退出码契约、报告上传、macOS + Windows 矩阵。仓库自己的 CI 不是对外产品。
- **稳定 HTTP/WebSocket runner API**
- **npm 发布 `@agentchaos/runner`**，不必从源码 `setup`

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

首选 **Rust** 作为核心执行器和跨平台 helper 语言。它适合长期运行的进程监督、并发事件流、PTY/ConPTY、网络代理和资源控制，单二进制发布，内存安全，Mac/Windows 行为容易保持一致，适合维护一个跨平台核心。

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
