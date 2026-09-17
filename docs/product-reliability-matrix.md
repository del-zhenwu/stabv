# 主流 Agent 可靠性证据与 AgentChaos 覆盖矩阵

更新：2026-09-16

## 阅读方式

这里的“缺陷”来自官方 issue、release note、错误文档或产品 changelog。公开 issue 证明某种失败模式真实存在，不代表它的发生率或当前版本仍然存在。AgentChaos 的覆盖分为：

- **已支持**：当前 CLI/runner/helper 可以直接注入并断言。
- **可降级验证**：可以用 CLI、generic-cli、协议代理或文件/进程证据近似，但不能覆盖产品真实 UI 或内部事件。
- **不支持**：需要尚未实现的桌面桥、native event、MCP/subagent 适配或 OS 能力。

## 共同故障模式

| 公开证据中反复出现的模式 | 典型产品证据 | AgentChaos 当前覆盖 |
| --- | --- | --- |
| 长上下文、compaction 失败或语义丢失 | Claude 错误文档记录 compaction 因上下文过长失败；Claude release notes 持续修复 compaction、resume 和 summary 顺序问题；Kimi 1.49.0 调整 completion-token budget 以减少 context overflow | `compaction.interrupt` 已有；压缩后语义等价和 token budget drift 仍不完整 |
| session 持久化、resume 和恢复状态错误 | OpenCode 报告桌面崩溃后 active session 未持久化；Claude 修复 resume interrupted turn 和 compaction 后恢复；Codex 提供 `exec resume` | Codex/ZCode CLI kill-resume、session id 连续性和 `resumeSuccess` 已支持；桌面恢复不支持 |
| 进程还活着但无输出、永久卡住 | Claude `/compact` desktop local-agent 永久挂起；Zed ACP agent 无输出挂起；Zed checkpoint 失败后 prompt 永久 spinner | process pause/kill、timeout、`not_timed_out`、响应性断言已支持；UI spinner 和内部 deadlock 只能间接验证 |
| 进程树、资源和系统稳定性 | Codex Windows sleep 后 app headless/app hang；Codex Windows commit memory/反复 crash；Zed Agent/ACP 导致 CPU/内存高 | helper process tree、CPU/memory/port、orphans 已支持；真实桌面 memory leak 和系统 hang 不支持 |
| tool/ACP/MCP 协议或 checkpoint 失步 | Zed ACP 写文件 UI freeze、ACP checkpoint/git 错误；Kimi 修复 TTY exit hang、MCP shutdown；Claude release notes 持续修复 MCP、worktree、subagent | LLM/MCP HTTP 代理、MCP stdio 真实上游代理与请求去重/副作用隔离（`mcp_stdio_upstream_consistent`）、stdio 半写入/分块、subagent 派生与检查点回滚恢复（`subagent_checkpoint_restored`）、native JSON event、Git lock/conflict/worktree 已支持；完整 ACP host 桥接仍待落地 |
| 文件、Git、worktree 和外部状态变化 | Zed issue 中出现 untracked mass、worktree/checkpoint、binary file 和文件变更导致 hang；Claude 修复 worktree 删除卡住 | file edit/delete/chmod/lock、Git lock/conflict/switch branch、worktree 残留与锁定清理已支持；worktree 级恢复断言已支持 |
| UI、renderer、更新和 OS 生命周期 | OpenCode desktop renderer crash loop；Zed Windows ACP write freeze、WSL crash；Codex Windows sleep/resume 和 AppX relaunch | CLI black-box 已支持；native window close/text input/screenshot 证据采集与 freeze 响应性探测已接入；desktop 深度 renderer 崩溃、输入结果确认、sleep/wake、TCC/UAC 向导仍不支持 |

## 产品证据

### Codex / Codex Desktop

公开 Codex issue 已出现 Windows 长时间 sleep 后 app headless、resume 后系统无响应，以及 AppX 容器被销毁/重启但没有对应 fatal log 的报告；另有 commit memory exhausted、反复 crash 的报告。[sleep/resume issue](https://github.com/openai/codex/issues/36291) · [AppX relaunch issue](https://github.com/openai/codex/issues/31583) · [memory/crash issue](https://github.com/openai/codex/issues/38765)

当前能测：Codex `exec --json` 启动、stdout JSON event、process kill/pause、workspace/file/Git/network/LLM fault、孤儿进程、timeout、kill-resume（非 ephemeral session）。

当前不能完整测：Codex Desktop 窗口、AppX/TCC、renderer、sleep/wake、系统级 memory pressure、桌面 session 恢复。Codex 官方产品资料也把 sandbox、网络访问和本地/云环境作为产品级边界；这些应作为独立 OS/Desktop suite，而不是误当成 CLI fault。[Codex product risk report](https://cdn.openai.com/pdf/ac7c37ae-7f4c-4442-b741-2eabdeaf77e0/oai_5_2_Codex.pdf)

### Claude Code / Claude Desktop local-agent

Claude 官方错误文档明确记录了“Conversation too long”导致 compaction 失败，以及失败后需要回退消息或重新开始。[错误文档](https://code.claude.com/docs/en/errors) 官方 release notes 还持续修复 interrupted turn resume、compaction summary、resume 顺序、worktree 删除和 MCP/Slack 工具状态。[releases](https://github.com/anthropics/claude-code/releases)

公开 issue 报告 Claude Desktop local-agent `/compact` 永久挂起：CLI 进程仍活着，transcript 不再推进，UI 计时器继续增长；另有 oversized transcript 导致桌面启动时 V8 OOM。[compact hang](https://github.com/anthropics/claude-code/issues/75400) · [desktop OOM](https://github.com/anthropics/claude-code/issues/69009)

当前能测：CLI 进程/工具/文件/Git/网络/LLM/MCP HTTP、JSON event、timeout、process tree、session resume 的黑盒部分。

当前不能完整测：Claude Desktop renderer/UI、真实 compaction 内部边界、SDK/native subagent 结果一致性、桌面 transcript 扫描 OOM。`compaction.interrupt` 可以作为故障近似，但不能声称覆盖上述桌面缺陷。

### Kimi Code

Kimi 官方 changelog 记录了长会话 context overflow 的 completion-token 修复、TTY exit hang、MCP shutdown、ACP session history replay，以及长 conversation 的 transcript rendering 优化。[Kimi changelog](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/release-notes/changelog.md) · [Kimi docs changelog](https://www.kimi.com/code/docs/en/kimi-code-cli/release-notes/changelog.html)

当前能测：generic-cli/具名 CLI adapter、进程树、文件/Git、输入、网络/LLM proxy、超时和基础恢复。

当前不能完整测：Kimi 内部 TUI renderer、视频输入、ACP/stdio MCP 精确故障、跨版本 session migration。TTY/ConPTY 相关问题只有在 `target.pty: true` 并使用 helper 时才有较高覆盖。

### ZCode / Zed Agent / ACP

Zed 官方 release notes 持续修复 ACP agent 下载、流式多字节编辑 crash 和文件系统变化无响应。[Zed stable releases](https://zed.dev/releases/stable?page=4) 公开 issue 报告了 Windows ACP 写文件卡死、Windows/WSL 中 Codex 和 Claude ACP 引发 crash、ACP agent 无输出挂起，以及 checkpoint/git 错误导致主线程长时间阻塞。[Windows ACP write freeze](https://github.com/zed-industries/zed/issues/61227) · [WSL ACP crashes](https://github.com/zed-industries/zed/issues/61214) · [ACP no-output hang](https://github.com/zed-industries/zed/issues/52151) · [checkpoint/main-thread hang](https://github.com/zed-industries/zed/issues/49432)

当前能测：把 ZCode 或外部 ACP agent 当作 CLI/process target，测进程、PTY、文件、Git、网络和协议代理故障。

当前不能完整测：Zed editor renderer、GPUI、Agent Panel、ACP host 的 buffer/checkpoint/UI 关系、WSL remote bridge、Windows UI Automation。这里的失败通常需要桌面端 Chaos；仅杀外部 agent 进程不能等价复现 Zed crash。

### Cursor

Cursor changelog 把 agent harness、context management、subagents、MCP reliability、parallel agent reliability、process separation 和 cloud-agent long-running subscriptions 作为持续演进的对象。[Cursor 2.4 harness changelog](https://cursor.com/changelog/2-4) · [Cursor latest changelog](https://prod.cursor.com/en-US/changelog) · [Cursor 2.3 stability](https://forum.cursor.com/t/cursor-2-3-layout-customization-and-stability-improvements/147075)

公开资料还显示 Cursor 同时存在本地 editor agent、CLI、cloud agent、self-hosted machine 和事件触发的长期 agent；这些不是同一个故障面。[Cursor cloud/self-hosted changelog](https://prod.cursor.com/en-US/changelog)

当前能测：若能使用 CLI 或可配置 endpoint，走 `generic-cli`、LLM/MCP proxy、process/file/Git/resource fault；可测 cloud agent 的 API contract 需要另外的远程 adapter。

当前不能完整测：Cursor editor renderer、扩展宿主、cloud scheduler/subscription、远程机器生命周期、IDE indexing 和本地/云 agent 状态同步。AgentChaos 不应把 Cursor CLI 的结果当成 Cursor Desktop 或 Cloud Agent 的完整覆盖。

### OpenCode

公开 issue 报告了桌面崩溃后 active session 未持久化，以及恢复 tab 指向已删除 session/location 时启动 renderer crash loop；另有 server `session.error` 风暴和无自动恢复的稳定性问题。[session not persisted](https://github.com/anomalyco/opencode/issues/8352) · [desktop renderer crash loop](https://github.com/anomalyco/opencode/issues/40373) · [server crash resilience](https://github.com/anomalyco/opencode/issues/26646)

当前能测：OpenCode CLI 若能稳定以 `executable + args` 启动，可复用 generic-cli 的 process/file/Git/network/protocol faults。

当前不能完整测：OpenCode Desktop renderer、tab/session restore、server supervisor 和 web/desktop 两端状态同步。

### GitHub Copilot CLI

Copilot CLI 的官方 changelog 记录了多类与 AgentChaos 直接相关的修复：并发文件编辑审批曾经卡住、审批中的 Ctrl+C 会 hang、Windows 更新遇到 EPERM、large attachment 导致 100% CPU hang、session resume 选择器重复，以及 MCP background tasks。[Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md) 官方命令文档也明确说明，CLI 进程因 crash 或机器重启后可以发现并恢复未关闭 session。[Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)

当前能测：generic-cli 的进程树、输入/取消、文件并发外部修改、网络/LLM/MCP HTTP、session resume 的黑盒行为。

当前不能完整测：Copilot IDE/VS Code/JetBrains UI、GitHub Tasks/远程 agent、插件宿主和企业策略下的权限/更新行为。

### Gemini CLI

Gemini CLI 官方 changelog 持续涉及 ContextManager、PTY resize、Termux relaunch、workspace trust、task isolation 和 infinite ReAct/prompt-injection loop mitigation。[Gemini CLI changelog](https://github.com/google-gemini/gemini-cli/blob/main/docs/changelogs/index.md)

当前能测：generic-cli、PTY/ConPTY、process/resource、workspace、网络/LLM proxy 和输出/超时。

当前不能完整测：Google Code Assist 账户与配额、A2A server 的远端生命周期、原生 workspace trust/Seatbelt 策略细节，以及 Gemini CLI 的完整 context manager 内部状态。

### Cline / Roo Code

Cline CLI/SDK changelog 记录了 malformed tool input 恢复、detached hub event、session-not-found、Hub shutdown race、worktree resume、Windows PowerShell UTF-8 stdin 和 checkpoint restore；这些说明 Agent 可靠性同样集中在 session、事件总线、工具输入和跨平台 shell。[Cline CLI changelog](https://github.com/cline/cline/blob/main/apps/cli/CHANGELOG.md) · [Cline SDK changelog](https://github.com/cline/cline/blob/main/sdk/CHANGELOG.md)

Roo Code release notes 记录了 rate-limit 状态、意外文件路径、skills 和 context management 等问题。[Roo Code release notes](https://roocodeinc.github.io/Roo-Code/update-notes/v3.38.2/)

当前能测：CLI 进程、stdin/PTY、文件/Git、网络和协议故障；Cline 的 Hub 可作为 generic-cli/MCP-like process target。

当前不能完整测：IDE extension/webview、Hub 与多个桌面 session 的内部事件、远端 connector、完整 checkpoint/restore 语义。

## 能力差距结论

### 当前已经覆盖的共性缺陷

- 进程 kill/pause/restart 和进程树清理
- 子进程泄漏、孤儿进程、超时与子 Agent 派生/检查点一致性恢复（`subagent.checkpoint` / `subagent_checkpoint_restored`）
- 外部文件 edit/delete/chmod/lock/大文件
- Git lock/conflict/switch branch、Git worktree 残留与锁定
- 网络 delay/timeout/reset、LLM 401/429/500/truncate/malformed/schema drift/duplicate/empty/corrupt/html/stale_*/wrong_entity（支持字段级修改与注入时间表，OpenAI 与 Anthropic Messages 协议）
- MCP HTTP proxy 故障与 MCP stdio 真实上游代理、请求去重与副作用隔离（`mcp_stdio_upstream_consistent`）、stdio 半写入/分块输出
- 隔离环境 Session 存储损坏、截断、文件锁与表结构漂移（`session.schema_drift` / `session_clean_recovery`）
- 原生桌面窗口控制、按键模拟、屏幕截图证据捕获（`desktop.screenshot` / `desktop_screenshot_captured`）与 UI 冻结探测（`desktop.freeze` / `desktop_unresponsive_detected`）
- 远端云端协调器生命周期：租约有效性、心跳超时、断连重连（`remote.*` / `remote_lease_valid` / `remote_reconnect_success`）
- 真实极限资源测试：文件描述符耗尽（`resource.handle_exhaustion`）、隔离工作区写满（`resource.disk_exhaustion`）与恢复后自愈探测（`resource_exhaustion_recovered`）
- input send/eof、approval drop/delay/deny 的 CLI 近似
- compaction interrupt 的故障注入近似
- JSON event、session id、tool id、workspace/Git hash 的事件记录
- kill-resume、recovery、MTTR、resumeSuccess、duplicate side effect、lost tool results、state divergence、user takeover 等指标
- macOS/Windows CLI helper：进程树、Job Object、PTY/ConPTY、文件锁、资源注入、版本化协议与 `HelperWorker` 生命周期管理

### 只能降级验证的缺陷

- 真实 desktop UI 卡死：可通过 `desktop.freeze` 与响应性探测验证进程层，但深度 GPU 渲染死锁仍需专属桌面 adapter
- LLM 代理不被产品采用时：只能验证 agent 的外部协议，不代表官方云后端
- ACP：仍只能测外部 CLI 黑盒；需进一步补充专用 host 协议桥接
- context compaction：可以中断或制造长输入，但不能观察产品内部 summary 是否保留所有约束
- Cursor cloud、Codex cloud 等大型生产云服务：可通过本地 `RemoteCoordinator` 模拟租约、心跳和断连，但无法替代云端厂商的私有分布式协调器

### 明确还不支持的缺陷

- macOS TCC 授权弹窗 / Windows UAC 交互向导
- renderer/webview/GPUI/Electron 内部 DOM 崩溃注入与热重载恢复
- 系统级的 sleep/wake、外接显示器/DPI 拔插切换、自动更新打断
- 完整 ACP host bridge 和 UI checkpoint
- 宿主机无看门狗保护的系统级物理 OOM 宕机（AgentChaos 始终维持宿主机健康卫士）
- 生产环境真实分布式多可用区网络分区（单机已提供 `RemoteCoordinator` 模拟）

## 建议新增的产品 suites

1. `cli-harness-common.yaml`：所有 CLI Agent 共用，process/file/Git/network/timeout。
2. `session-recovery.yaml`：Codex/Claude/Kimi/ZCode 的 session id、kill-resume、compaction 近似。
3. `protocol-chaos.yaml`：LLM/MCP HTTP fault，不要求真实模型登录。
4. `desktop-boundary.yaml`：仅在实现 `generic-desktop` 后运行，覆盖窗口、renderer、输入、sleep/wake、权限和更新。
5. `remote-agent.yaml`：Cursor cloud、Codex cloud、Zed remote/WSL 等远程生命周期和同步。

不要用 CLI suite 通过来宣称桌面产品可靠；也不要用桌面 crash 直接归因模型。报告应分别记录 `agent/harness`、`workspace/process`、`protocol/provider`、`desktop/os` 四个故障域。
