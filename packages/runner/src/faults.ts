import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import type { EventStore } from "./events.ts";
import type { HelperClient } from "./helper.ts";
import type { ConnectProxy, LlmProxy } from "./proxy.ts";
import type { Fault, FileFault, GitFault, InputFault, LlmFault, NetworkFault, ProcessFault, ResourceFault } from "./spec.ts";
import { faultLabel } from "./spec.ts";
import { assertInsideWorkspace, ensureParent } from "./workspace.ts";

export type FaultContext = {
  work: string;
  helper: HelperClient;
  events: EventStore;
  getPid: () => number | undefined;
  writeStdin?: (data: string) => void;
  closeStdin?: () => void;
  network?: ConnectProxy;
  llm?: LlmProxy;
  children: ChildProcess[];
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
      if (child.exitCode == null && child.pid) child.kill("SIGKILL");
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
  const duration = fault.durationMs ?? 2000;
  const child =
    fault.action === "cpu"
      ? ctx.helper.spawnCpuStress(duration, fault.threads ?? 2)
      : ctx.helper.spawnMemStress(duration, fault.mb ?? 64);
  ctx.children.push(child);
  return async () => {
    if (child.exitCode == null) child.kill("SIGKILL");
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

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr?.on("data", (b) => (err += b.toString()));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `git failed (${code})`))));
    child.on("error", reject);
  });
}
