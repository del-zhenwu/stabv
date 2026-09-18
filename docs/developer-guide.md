# AgentChaos 开发者手册

本文档介绍如何在本仓库中开发与调试 AgentChaos。最终用户通过 npm 包 `agentchaos` 安装。

相关文档：[设计说明](./design.md)、[技术说明](./technical.md)、[接入 CLI Adapter](./cli-adapter.md)、[协作指南](./agent-guidelines.md)。

---

## 1. 分层

控制面与执行面分离：

```text
┌────────────────────────────────────────────────────────┐
│  TypeScript 控制面 (packages/runner)                   │
│  · YAML 解析、模型序列化、工作流调度 (runner / workflow)│
│  · 透明网络代理 (proxy.ts: LLM OpenAI/Anthropic, MCP) │
│  · 标准输出 Native Event 分类 (native-events.ts)       │
│  · 断言判断 (assertions.ts) 与报告生成 (report.ts)      │
│  · CLI 命令行与本地 Web 观察器 (cli.ts / view.ts)      │
└──────────────────────────┬─────────────────────────────┘
                           │ 结构化 IPC 命令（禁止在 TS 中直接操作 OS 树）
                           ▼
┌────────────────────────────────────────────────────────┐
│  Rust Platform Helper (helper/)                        │
│  · 跨平台进程树枚举与销毁 (kill-tree / kill-process)   │
│  · 进程挂起与恢复 (pause-tree / resume-tree)           │
│  · 跨平台伪终端 (pty-spawn: Unix PTY / Win ConPTY)     │
│  · 系统级文件锁与权限映射 (flock / LockFileEx / acl)   │
│  · 物理资源压力施加 (cpu-stress / mem-stress / disk)   │
└────────────────────────────────────────────────────────┘
```

- TypeScript 控制面不直接操作进程树（不调用 `process.kill(-pid)`、不解析 `ps`、不调用 `taskkill` / `wmic`）。
- Rust helper 不解析 YAML、不拼装特定 Agent 参数、不编排实验。

---

## 2. 目录结构与模块导航

```text
packages/runner/src/
  cli.ts           CLI 命令行入口 (setup/validate/run/suite/workflow/view/...)
  spec.ts          实验规格模型解析、校验与字段规范化
  runner.ts        调度主循环（故障注入时钟、事件监听、状态快照）
  faults.ts        各类故障的实际注入与恢复清理实现
  helper.ts        HelperClient（与 Rust agentchaos-helper 交互的客户端）
  proxy.ts         ConnectProxy (网络)、LlmProxy (OpenAI+Anthropic)、McpProxy
  remote.ts        RemoteCoordinator 本地云端协调器（租约、心跳、远端检查点管理）
  mcp-stdio.ts     MCP Stdio 交互代理与动态故障拦截器（支持上游代理、副作用去重、半写入）
  native-events.ts 从 Agent 标准输出提取结构化 native event
  observe.ts       工作区哈希快照、Git 状态提取、代码验证执行器
  assertions.ts    实验结束时的不变量检查引擎
  report.ts        生成 report.json、report.html、report.md 并计算可靠性指标
  adapters.ts      Agent 启动参数拼装与无界面会话恢复管理
  view.ts          本地轻量 HTTP Web Viewer 服务器

helper/src/
  main.rs          命令行分发、CLI 参数解析、结构化 JSON 输出与版本化协议能力发现
  process.rs       Unix 进程树枚举 (ps) 与信号控制 (SIGKILL/SIGSTOP/SIGCONT)
  win.rs           Windows 10+ 原生系统调用 (Job Object, Toolhelp32, LockFileEx, ConPTY, UI Automation)
  desktop.rs       macOS Accessibility / screencapture 与 Windows UI Automation 原生桌面桥接
  resource.rs      CPU 加压、内存加压、真实句柄耗尽 (handle-stress)、真实磁盘填满 (disk-exhaustion)、文件锁 (flock)
  pty.rs           跨平台伪终端转发与子进程绑定
```

---

## 3. 本地开发与调试流程

### 3.1 编译与测试
依赖：Node.js 22+、Rust (Cargo)。

**Windows 10+**
```bat
scripts\setup.cmd
npm test
```

**macOS / Linux**
```bash
./scripts/setup.sh
npm test
```

- `npm test` 会自动触发 `cargo build -p agentchaos-helper`，并运行 `packages/runner/test/control-plane.test.ts` 中的全部测试（无外部网络/登录依赖）。
- 用户路径 e2e 在 `tests/e2e-zcode-user.test.ts`（`node:test`）：先 `npm run pack` 并安装 tgz，再 `npm run test:e2e`。`examples/zcode.yaml` 展开成多条 `it()`，一条故障一条测试，进度看框架的 ✔/✖。不进默认 `npm test`。CI 每次都会运行 e2e；只需配置已有的 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL` Secrets，workflow 会将它们映射为 ZCode 兼容变量，无需重复配置。GitHub 托管 runner 默认没有 ZCode，可用仓库变量 `E2E_RUNNER` 指到有 ZCode 的机器。
- 单独调试 Helper：`cargo test -p agentchaos-helper`。
- 改 `helper/` 后，GitHub Actions `prebuilt-helper` 会编好 `darwin-arm64`、`darwin-x64`、`win32-x64`，校验齐全后写回 `prebuilt/`。缺一份就不能 `npm publish`。用户装包不编 Rust。

### 3.2 运行环境覆盖
Helper 产物默认位于 `target/debug/agentchaos-helper`（Windows 为 `.exe`）。可通过环境变量覆盖：
```bash
export AGENTCHAOS_HELPER=/path/to/custom-helper
```

---

## 4. Helper IPC 通信规范

Helper 作为单次执行的子进程运行，**向 stdout 仅输出单行标准 JSON**：
- 成功：`{"ok": true, ...}`
- 失败：`{"ok": false, "error": "具体错误信息"}`，且进程退出码非 0。

### 支持的核心子命令：
```text
agentchaos-helper caps
agentchaos-helper list-tree <pid>
agentchaos-helper kill-tree <pid>
agentchaos-helper kill-process <pid>
agentchaos-helper pause-tree <pid>
agentchaos-helper resume-tree <pid>
agentchaos-helper cpu-stress --duration-ms N --threads N
agentchaos-helper mem-stress --duration-ms N --mb N
agentchaos-helper disk-stress --duration-ms N --mb N [--path P]
agentchaos-helper handle-stress --duration-ms N [--limit N]
agentchaos-helper disk-exhaustion --duration-ms N --path P [--max-mb N]
agentchaos-helper desktop-screenshot --path P
agentchaos-helper desktop-is-responsive <pid>
agentchaos-helper flock --path P --duration-ms N
agentchaos-helper acl --path P --mode 000
agentchaos-helper pty-spawn --cwd DIR -- [argv...]
```
> 特例说明：`pty-spawn` 在子进程启动瞬间向 **stderr** 输出一行 JSON 握手 `{"ok":true,"pid":...,"pty":true}`，随后 stdout/stdin 转换为原生的终端二进制字符流。
> `caps` 返回当前 Helper 的能力清单及 IPC 协议版本号（当前为 `"protocol_version": "1.1.0"`）。
> 所有长时压力任务由 TypeScript 端的 `HelperWorker` 统一管理生命周期与清理（`stopWorker` / `stopAllWorkers`）。

---

## 5. 新增故障类型

当需要在系统中扩展一种全新的故障注入能力时，按以下依赖顺序开发：

```text
1. 扩展 spec.ts       定义 YAML 类型、参数与 normalizeFault 解析规则
       ↓
2. 扩展 faults.ts     编写 inject* 函数，返回必须的 recover 清理闭包
       ↓
3. 扩展 helper/ (若需) 在 Rust 中实现跨平台原生 API，并封装在 HelperClient 中
       ↓
4. 新增 YAML 样例     在 examples/ 下添加小巧的验证实验
       ↓
5. 补充自动化测试     在 control-plane.test.ts 中添加对应单元测试断言
```

### 关键细节要求：
- **路径必须防逃逸**：涉及文件路径的故障必须调用 `assertInsideWorkspace(ctx.work, fault.path)`，严禁 `..` 越界。
- **故障恢复必须幂等安全**：有 `durationMs` 的故障会在超时后被调度恢复；即使实验异常中断，`runner.ts` 的 `finally` 块也会执行恢复，必须确保资源（端口、文件锁、加压子进程）被完全清理，不污染下一个用例。

---

## 6. 控制面自动化测试原则

`packages/runner/test/control-plane.test.ts` 的约定：
1. **无外部网络、无登录凭据**：测试不请求真实的 OpenAI / Anthropic / Kimi API，不依赖真实 Agent 登录。
2. **使用内置替身或 Mock**：
   - 协议测试：直接向内置的 `LlmProxy`、`McpProxy`、`agentchaos-mcp-stdio.js` 发送请求。
   - 进程生命周期测试：使用 `generic-cli` 配合 Node.js 短脚本模拟 Agent 行为。
3. **确定性断言**：依据 `events.jsonl`、`shadow_compare`、工作区哈希与退出码判定。

---

## 7. 平台差异与未实现清单

| 能力模块 | macOS / Linux | Windows 10+ |
| --- | --- | --- |
| 进程树发现 | `/bin/ps` 管道递归遍历 | Toolhelp32 快照 API |
| 进程树销毁 | `libc::kill(-pid, SIGKILL)` | Win32 Job Object + `TerminateProcess` |
| 单进程精准销毁 | `libc::kill(pid, SIGKILL)` | `OpenProcess` + `TerminateProcess` |
| 挂起与恢复 | `SIGSTOP` / `SIGCONT` | `SuspendThread` / `ResumeThread` |
| 文件锁 | POSIX `flock(fd, LOCK_EX)` | Win32 `LockFileEx` |
| 虚拟终端 | Unix PTY (`forkpty` / openpty) | Windows 10+ ConPTY 原生伪终端 |
| 权限映射 | POSIX mode 权限位 | Windows 只读文件属性 (`FILE_ATTRIBUTE_READONLY`) |

### 尚未实现
- 完整 generic-desktop adapter、桌面 renderer/webview 内部 crash、窗口点击结果确认。
- 系统弹窗自动化（macOS TCC 权限、Windows UAC 提权向导）。
- 宿主机物理休眠/唤醒（Sleep / Wake）。
- 宿主机级物理内存彻底 OOM、文件系统底层损坏；隔离工作区的句柄/磁盘耗尽已支持。
