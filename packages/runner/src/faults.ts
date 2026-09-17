import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import type { EventStore } from "./events.ts";
import type { HelperClient } from "./helper.ts";
import type { ConnectProxy, LlmProxy, McpProxy } from "./proxy.ts";
import type { RemoteCoordinator } from "./remote.ts";
import type {
  ApprovalFault,
  CompactionFault,
  DesktopFault,
  Fault,
  FileFault,
  GitFault,
  InputFault,
  LlmFault,
  McpFault,
  NetworkFault,
  ProcessFault,
  RemoteFault,
  ResourceFault,
  RuleFault,
  ContextFault,
  SessionFault,
  SubagentFault,
} from "./spec.ts";
import { faultLabel } from "./spec.ts";
import { assertInsideWorkspace, ensureParent } from "./workspace.ts";

export type FaultContext = {
  work: string;
  runRoot: string;
  sessionRoot?: string;
  helper: HelperClient;
  events: EventStore;
  getPid: () => number | undefined;
  writeStdin?: (data: string) => void;
  closeStdin?: () => void;
  network?: ConnectProxy;
  llm?: LlmProxy;
  mcp?: McpProxy;
  mcpPolicyFile?: string;
  remote?: RemoteCoordinator;
  children: ChildProcess[];
  recordSubagent?: (record: { type: string; id?: string; pid?: number }) => void;
  restart?: () => Promise<void>;
};

export async function injectFault(fault: Fault, ctx: FaultContext): Promise<() => Promise<void>> {
  await ctx.events.emit("fault_injected", { fault: faultLabel(fault), spec: fault });
  switch (fault.kind) {
    case "process":
      return injectProcess(fault, ctx);
    case "file":
      return injectFile(fault, ctx);
    case "git":
      return injectGit(fault, ctx);
    case "network":
      return injectNetwork(fault, ctx);
    case "llm":
      return injectLlm(fault, ctx);
    case "resource":
      return injectResource(fault, ctx);
    case "input":
      return injectInput(fault, ctx);
    case "mcp":
      return injectMcp(fault, ctx);
    case "approval":
      return injectApproval(fault, ctx);
    case "compaction":
      return injectCompaction(fault, ctx);
    case "subagent":
      return injectSubagent(fault, ctx);
    case "session":
      return injectSession(fault, ctx);
    case "desktop":
      return injectDesktop(fault, ctx);
    case "remote":
      return injectRemote(fault, ctx);
    case "rule":
      return injectRule(fault, ctx);
    case "context":
      return injectContext(fault, ctx);
  }
}

async function injectProcess(fault: ProcessFault, ctx: FaultContext): Promise<() => Promise<void>> {
  const pid = ctx.getPid();
  if (!pid) throw new Error("process fault requested before agent started");
  if (fault.action === "kill" || fault.action === "restart") {
    const tree = await ctx.helper.killTree(pid);
    await ctx.events.emit("process_tree", { action: "kill", tree });
    if (fault.action === "restart" && ctx.restart) {
      await ctx.events.emit("recovery_started", { action: "restart" });
      await ctx.restart();
    }
    return async () => undefined;
  }
  const tree = await ctx.helper.pauseTree(pid);
  await ctx.events.emit("process_tree", { action: "pause", tree });
  return async () => {
    const resumed = await ctx.helper.resumeTree(pid);
    await ctx.events.emit("fault_recovered", { fault: faultLabel(fault), tree: resumed });
  };
}

async function injectFile(fault: FileFault, ctx: FaultContext): Promise<() => Promise<void>> {
  const path = assertInsideWorkspace(ctx.work, fault.path);
  if (fault.action === "edit") {
    await ensureParent(path);
    const body = fault.sizeBytes != null ? Buffer.alloc(fault.sizeBytes, 0x41) : fault.content ?? "chaos\n";
    await writeFile(path, body);
  } else if (fault.action === "delete") {
    await rm(path, { force: true, recursive: true });
  } else if (fault.action === "rename") {
    if (!fault.to) throw new Error("file.rename requires to");
    const to = assertInsideWorkspace(ctx.work, fault.to);
    await ensureParent(to);
    await rename(path, to);
  } else if (fault.action === "chmod") {
    if (process.platform === "win32") {
      await ctx.helper.acl(path, fault.mode ?? "000");
    } else {
      await chmod(path, parseInt(fault.mode ?? "000", 8));
    }
  } else if (fault.action === "symlink") {
    if (!fault.linkTarget) throw new Error("file.symlink requires target");
    await ensureParent(path);
    await symlink(fault.linkTarget, path);
  } else if (fault.action === "lock") {
    await ensureParent(path);
    const duration = fault.durationMs ?? 2000;
    const child = ctx.helper.spawnFlock(path, duration);
    ctx.children.push(child);
    return async () => {
      ctx.helper.stopWorker(child);
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
    };
  }
  return async () => undefined;
}

async function injectGit(fault: GitFault, ctx: FaultContext): Promise<() => Promise<void>> {
  if (fault.action === "lock") {
    const lock = join(ctx.work, ".git/index.lock");
    await mkdir(join(ctx.work, ".git"), { recursive: true });
    await writeFile(lock, `agentchaos ${Date.now()}\n`);
    return async () => {
      await rm(lock, { force: true });
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
    };
  }
  if (fault.action === "conflict") {
    const path = assertInsideWorkspace(ctx.work, fault.path ?? "CONFLICT.md");
    await ensureParent(path);
    await writeFile(
      path,
      fault.content ?? "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> chaos\n",
    );
    return async () => undefined;
  }
  if (fault.action === "worktree-leak" || fault.action === "worktree-lock") {
    const rel = fault.path ?? ".agentchaos-worktree";
    const target = assertInsideWorkspace(ctx.work, rel);
    const branch = fault.branch ?? "agentchaos-wt";
    await git(ctx.work, ["worktree", "add", "-B", branch, target]);
    if (fault.action === "worktree-lock") {
      await git(ctx.work, ["worktree", "lock", target, "--reason", "agentchaos fault"]);
    }
    return async () => {
      if (fault.action === "worktree-lock") {
        await git(ctx.work, ["worktree", "unlock", target]).catch(() => undefined);
      }
      await git(ctx.work, ["worktree", "remove", "--force", target]).catch(() => undefined);
      await git(ctx.work, ["branch", "-D", branch]).catch(() => undefined);
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
    };
  }
  await git(ctx.work, ["checkout", "-B", fault.branch ?? "agentchaos-chaos"]);
  return async () => undefined;
}

async function injectNetwork(fault: NetworkFault, ctx: FaultContext): Promise<() => Promise<void>> {
  if (!ctx.network) throw new Error("network proxy was not started");
  ctx.network.setPolicy({
    action: fault.action,
    delayMs: fault.delayMs ?? fault.durationMs ?? 1000,
  });
  return async () => {
    ctx.network?.setPolicy({ action: "pass" });
    await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
  };
}

async function injectLlm(fault: LlmFault, ctx: FaultContext): Promise<() => Promise<void>> {
  if (!ctx.llm) throw new Error("llm proxy was not started");
  ctx.llm.setPolicy({
    action: fault.action,
    delayMs: fault.delayMs ?? fault.durationMs ?? 1000,
    field: fault.field,
    schedule: fault.schedule,
    probability: fault.probability,
    burst: fault.burst,
    callIndex: fault.callIndex,
    seed: fault.seed,
  });
  return async () => {
    ctx.llm?.setPolicy({ action: "pass" });
    await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
  };
}

async function injectResource(fault: ResourceFault, ctx: FaultContext): Promise<() => Promise<void>> {
  if (fault.action === "port") {
    const port = fault.port ?? 9876;
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    return async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
    };
  }
  if (fault.action === "handle_exhaustion") {
    const duration = fault.durationMs ?? 2000;
    const worker = ctx.helper.startHandleStressWorker(duration, fault.limit);
    ctx.children.push(worker.child);
    return async () => {
      await worker.stop();
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
    };
  }
  if (fault.action === "disk_exhaustion") {
    const duration = fault.durationMs ?? 2000;
    const targetPath = fault.path ? assertInsideWorkspace(ctx.work, fault.path) : join(ctx.work, ".agentchaos-disk-exhaustion");
    const worker = ctx.helper.startDiskExhaustionWorker(duration, targetPath, fault.mb);
    ctx.children.push(worker.child);
    return async () => {
      await worker.stop();
      await rm(targetPath, { force: true }).catch(() => undefined);
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
    };
  }
  if (fault.action === "disk") {
    const duration = fault.durationMs ?? 2000;
    const mb = fault.mb ?? 128;
    const targetPath = fault.path ? assertInsideWorkspace(ctx.work, fault.path) : undefined;
    const worker = ctx.helper.startDiskStressWorker(duration, mb, targetPath);
    ctx.children.push(worker.child);
    return async () => {
      await worker.stop();
      if (targetPath) await rm(targetPath, { force: true }).catch(() => undefined);
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
    };
  }
  const duration = fault.durationMs ?? 2000;
  const worker =
    fault.action === "cpu"
      ? ctx.helper.startCpuStressWorker(duration, fault.threads ?? 2)
      : ctx.helper.startMemStressWorker(duration, fault.mb ?? 64);
  ctx.children.push(worker.child);
  return async () => {
    await worker.stop();
    await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
  };
}

async function injectInput(fault: InputFault, ctx: FaultContext): Promise<() => Promise<void>> {
  if (fault.action === "eof") {
    ctx.closeStdin?.();
    return async () => undefined;
  }
  if (!ctx.writeStdin) throw new Error("input.send requires an open agent stdin");
  ctx.writeStdin(fault.text ?? "");
  return async () => undefined;
}

async function injectMcp(fault: McpFault, ctx: FaultContext): Promise<() => Promise<void>> {
  const delayMs = fault.delayMs ?? fault.durationMs ?? 1000;
  if (ctx.mcp && fault.action !== "crash") {
    ctx.mcp.setPolicy({
      action: fault.action,
      delayMs,
    });
  }
  if (ctx.mcpPolicyFile) {
    await writeFile(
      ctx.mcpPolicyFile,
      JSON.stringify({ action: fault.action, delayMs }),
    );
  }
  return async () => {
    ctx.mcp?.setPolicy({ action: "pass" });
    if (ctx.mcpPolicyFile) {
      await writeFile(ctx.mcpPolicyFile, JSON.stringify({ action: "pass" })).catch(() => undefined);
    }
    await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
  };
}

async function injectApproval(fault: ApprovalFault, ctx: FaultContext): Promise<() => Promise<void>> {
  if (fault.action === "drop") {
    return async () => undefined;
  }
  if (fault.action === "delay") {
    return async () => {
      if (!ctx.writeStdin) throw new Error("approval.delay requires an open agent stdin");
      ctx.writeStdin(fault.text ?? "y\n");
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
    };
  }
  if (!ctx.writeStdin) throw new Error("approval.deny requires an open agent stdin");
  ctx.writeStdin(fault.text ?? "n\n");
  return async () => undefined;
}

async function injectCompaction(fault: CompactionFault, ctx: FaultContext): Promise<() => Promise<void>> {
  const pid = ctx.getPid();
  if (!pid) throw new Error("compaction fault requested before agent started");
  const tree = await ctx.helper.killTree(pid);
  await ctx.events.emit("process_tree", { action: "kill", reason: faultLabel(fault), tree });
  return async () => undefined;
}

async function injectSubagent(fault: SubagentFault, ctx: FaultContext): Promise<() => Promise<void>> {
  const agentPid = ctx.getPid();
  if (fault.action === "conflict") {
    const path = assertInsideWorkspace(ctx.work, fault.path ?? "subagent-conflict.txt");
    await ensureParent(path);
    await writeFile(path, `conflict written by subagent fault at ${Date.now()}\n`);
    return async () => undefined;
  }
  if (fault.action === "checkpoint") {
    const chkId = fault.checkpointId ?? `chk-${Date.now()}`;
    ctx.recordSubagent?.({ type: "checkpoint", id: chkId, pid: agentPid });
    await ctx.events.emit("subagent_checkpoint", { checkpointId: chkId, pid: agentPid });
    return async () => undefined;
  }

  if (!agentPid) {
    return async () => undefined;
  }

  let childPid: number | undefined;
  try {
    const tree = await ctx.helper.listTree(agentPid);
    let children = tree.processes.filter((p) => p.pid !== tree.root);
    if (fault.target) {
      children = children.filter((p) => p.command.includes(fault.target!));
    }
    if (children.length > 0) {
      childPid = children[children.length - 1].pid;
    }
  } catch {
    /* ignore tree query failures */
  }

  if (childPid) {
    if (fault.action === "kill" || fault.action === "fail") {
      await ctx.helper.killProcess(childPid);
      ctx.recordSubagent?.({ type: "killed", pid: childPid });
      await ctx.events.emit("subagent_killed", { pid: childPid, action: fault.action });
      return async () => {
        await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
      };
    }
    if (fault.action === "timeout") {
      await ctx.helper.pauseTree(childPid);
      await ctx.events.emit("subagent_paused", { pid: childPid });
      return async () => {
        await ctx.helper.resumeTree(childPid).catch(() => undefined);
        await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
      };
    }
  } else {
    await ctx.events.emit("subagent_fault_attempted", { action: fault.action, target: fault.target });
  }

  return async () => {
    await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
  };
}

async function injectSession(fault: SessionFault, ctx: FaultContext): Promise<() => Promise<void>> {
  const path = assertInsideWorkspace(ctx.sessionRoot ?? ctx.runRoot, fault.path);
  if (fault.action === "corrupt") {
    await writeFile(path, `\u0000agentchaos-corrupt-${Date.now()}\n`);
    return async () => {
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault), path });
    };
  }
  if (fault.action === "truncate") {
    await writeFile(path, "");
    return async () => {
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault), path });
    };
  }
  if (fault.action === "schema_drift") {
    await writeFile(path, `\u0000-- SCHEMA DRIFT agentchaos --\nCREATE TABLE invalid_schema_broken (id INT);\n`);
    return async () => {
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault), path });
    };
  }
  const worker = ctx.helper.startFlockWorker(path, fault.durationMs ?? 2000);
  ctx.children.push(worker.child);
  return async () => {
    await worker.stop();
    await ctx.events.emit("fault_recovered", { fault: faultLabel(fault), path });
  };
}

async function injectDesktop(fault: DesktopFault, ctx: FaultContext): Promise<() => Promise<void>> {
  const pid = ctx.getPid();
  if (!pid) throw new Error("desktop fault requested before agent started");
  if (fault.action === "close_window") {
    await ctx.helper.desktopCloseWindow(pid);
  } else if (fault.action === "send_text") {
    await ctx.helper.desktopSendText(pid, fault.text ?? "");
  } else if (fault.action === "screenshot") {
    const targetPath = fault.path ? assertInsideWorkspace(ctx.runRoot, fault.path) : join(ctx.runRoot, `desktop-screenshot-${Date.now()}.png`);
    const captured = await ctx.helper.desktopScreenshot(targetPath);
    await ctx.events.emit("desktop_screenshot", { path: captured });
    return async () => undefined;
  } else if (fault.action === "freeze") {
    const tree = await ctx.helper.pauseTree(pid);
    await ctx.events.emit("desktop_action", { action: "freeze", pid, tree });
    return async () => {
      const resumed = await ctx.helper.resumeTree(pid).catch(() => undefined);
      await ctx.events.emit("fault_recovered", { fault: faultLabel(fault), tree: resumed });
    };
  }
  await ctx.events.emit("desktop_action", { action: fault.action, pid, text: fault.action === "send_text" ? fault.text : undefined });
  return async () => undefined;
}

async function injectRemote(fault: RemoteFault, ctx: FaultContext): Promise<() => Promise<void>> {
  if (!ctx.remote) throw new Error("remote coordinator was not started");
  ctx.remote.setPolicy({
    action: fault.action,
    delayMs: fault.durationMs ?? 3000,
  });
  return async () => {
    ctx.remote?.setPolicy({ action: "pass" });
    await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
  };
}

async function injectRule(fault: RuleFault, ctx: FaultContext): Promise<() => Promise<void>> {
  if (!ctx.llm) throw new Error("rule fault requires llm proxy");
  ctx.llm.setRulePolicy({
    action: fault.action,
    pattern: fault.pattern,
    ruleText: fault.ruleText,
  });
  return async () => {
    ctx.llm?.setRulePolicy({ action: "pass" });
    await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
  };
}

async function injectContext(fault: ContextFault, ctx: FaultContext): Promise<() => Promise<void>> {
  if (!ctx.llm) throw new Error("context fault requires llm proxy");
  ctx.llm.setContextPolicy({
    action: fault.action,
    poisonMessage: fault.poisonMessage,
  });
  return async () => {
    ctx.llm?.setContextPolicy({ action: "pass" });
    await ctx.events.emit("fault_recovered", { fault: faultLabel(fault) });
  };
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr?.on("data", (b) => (err += b.toString()));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `git failed (${code})`))));
    child.on("error", reject);
  });
}
