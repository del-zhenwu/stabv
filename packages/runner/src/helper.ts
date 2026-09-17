import { spawn, type ChildProcess } from "node:child_process";
import { repoRoot } from "./paths.ts";
import { findHelperBin, helperSearchPaths } from "./helper-bin.ts";

export type HelperTree = {
  root: number;
  alive: boolean;
  processes: { pid: number; ppid: number; command: string }[];
};

export type HelperCaps = {
  ok: boolean;
  name: string;
  version: string;
  protocol_version?: string;
  platform: string;
  min_os: string;
  capabilities: string[];
};

export interface HelperWorker {
  readonly id: string;
  readonly kind: "cpu" | "memory" | "disk" | "flock" | "handle" | "exhaustion";
  readonly child: ChildProcess;
  readonly pid?: number;
  readonly startedAt: number;
  stop(): Promise<void>;
}

export class HelperClient {
  private bin: string;
  private activeWorkers = new Set<HelperWorker>();

  constructor(bin: string) {
    this.bin = bin;
  }

  static tryDiscover(root = repoRoot()): HelperClient | undefined {
    const found = findHelperBin(root);
    return found ? new HelperClient(found) : undefined;
  }

  static discover(root = repoRoot()): HelperClient {
    const found = findHelperBin(root);
    if (!found) {
      throw new Error(
        `安装包缺了 ${process.platform}-${process.arch} 的 helper。这是包装问题，不要装 Rust 来补。(looked in ${helperSearchPaths(root).join(", ")})`,
      );
    }
    return new HelperClient(found);
  }

  get path(): string {
    return this.bin;
  }

  async caps(): Promise<unknown> {
    return this.run(["caps"]);
  }

  async listTree(pid: number): Promise<HelperTree> {
    const json = await this.run(["list-tree", String(pid)]);
    return json.tree as HelperTree;
  }

  async killTree(pid: number): Promise<HelperTree> {
    const json = await this.run(["kill-tree", String(pid)]);
    return json.tree as HelperTree;
  }

  async killProcess(pid: number): Promise<void> {
    await this.run(["kill-process", String(pid)]);
  }

  async pauseTree(pid: number): Promise<HelperTree> {
    const json = await this.run(["pause-tree", String(pid)]);
    return json.tree as HelperTree;
  }

  async resumeTree(pid: number): Promise<HelperTree> {
    const json = await this.run(["resume-tree", String(pid)]);
    return json.tree as HelperTree;
  }

  async desktopCloseWindow(pid: number): Promise<void> {
    await this.run(["desktop-close-window", String(pid)]);
  }

  async desktopSendText(pid: number, text: string): Promise<void> {
    await this.run(["desktop-send-text", String(pid), "--text", text]);
  }

  async desktopScreenshot(path: string): Promise<string> {
    const res = await this.run(["desktop-screenshot", "--path", path]);
    return (res?.path as string) ?? path;
  }

  async desktopIsResponsive(pid: number): Promise<boolean> {
    const res = await this.run(["desktop-is-responsive", String(pid)]);
    return Boolean(res?.responsive);
  }

  private registerWorker(kind: HelperWorker["kind"], child: ChildProcess): HelperWorker {
    let stopped = false;
    const worker: HelperWorker = {
      id: `worker-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      child,
      pid: child.pid,
      startedAt: Date.now(),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.activeWorkers.delete(worker);
        if (child.exitCode == null && child.pid) {
          child.kill("SIGKILL");
        }
      },
    };
    child.once("exit", () => {
      this.activeWorkers.delete(worker);
    });
    this.activeWorkers.add(worker);
    return worker;
  }

  /** Stop a short-lived helper worker owned by the runner. Target agent trees
   * must still be stopped through killTree/killProcess above. */
  stopWorker(workerOrChild: HelperWorker | ChildProcess): void {
    if ("stop" in workerOrChild && typeof workerOrChild.stop === "function") {
      void workerOrChild.stop();
      return;
    }
    const child = workerOrChild as ChildProcess;
    if (child.exitCode == null && child.pid) child.kill("SIGKILL");
  }

  stopAllWorkers(): void {
    for (const worker of [...this.activeWorkers]) {
      void worker.stop();
    }
    this.activeWorkers.clear();
  }

  startCpuStressWorker(durationMs: number, threads = 2): HelperWorker {
    const child = this.spawnCpuStress(durationMs, threads);
    return this.registerWorker("cpu", child);
  }

  startMemStressWorker(durationMs: number, mb = 64): HelperWorker {
    const child = this.spawnMemStress(durationMs, mb);
    return this.registerWorker("memory", child);
  }

  startDiskStressWorker(durationMs: number, mb = 128, path?: string): HelperWorker {
    const child = this.spawnDiskStress(durationMs, mb, path);
    return this.registerWorker("disk", child);
  }

  startDiskExhaustionWorker(durationMs: number, path: string, maxMb?: number): HelperWorker {
    const args = ["disk-exhaustion", "--duration-ms", String(durationMs), "--path", path];
    if (maxMb != null) args.push("--max-mb", String(maxMb));
    const child = spawn(this.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return this.registerWorker("exhaustion", child);
  }

  startHandleStressWorker(durationMs: number, limit?: number): HelperWorker {
    const args = ["handle-stress", "--duration-ms", String(durationMs)];
    if (limit != null) args.push("--limit", String(limit));
    const child = spawn(this.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return this.registerWorker("handle", child);
  }

  startFlockWorker(path: string, durationMs: number): HelperWorker {
    const child = this.spawnFlock(path, durationMs);
    return this.registerWorker("flock", child);
  }

  spawnCpuStress(durationMs: number, threads = 2) {
    return spawn(this.bin, ["cpu-stress", "--duration-ms", String(durationMs), "--threads", String(threads)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  spawnMemStress(durationMs: number, mb = 64) {
    return spawn(this.bin, ["mem-stress", "--duration-ms", String(durationMs), "--mb", String(mb)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  spawnDiskStress(durationMs: number, mb = 128, path?: string) {
    const args = ["disk-stress", "--duration-ms", String(durationMs), "--mb", String(mb)];
    if (path) args.push("--path", path);
    return spawn(this.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  spawnFlock(path: string, durationMs: number) {
    return spawn(this.bin, ["flock", "--path", path, "--duration-ms", String(durationMs)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  async acl(path: string, mode: string): Promise<void> {
    await this.run(["acl", "--path", path, "--mode", mode]);
  }

  spawnPty(opts: { cwd: string; env: NodeJS.ProcessEnv; argv: string[] }): { child: ReturnType<typeof spawn>; agentPid: Promise<number> } {
    const child = spawn(this.bin, ["pty-spawn", "--cwd", opts.cwd, "--", ...opts.argv], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return { child, agentPid: readPtyHandshake(child) };
  }

  private run(args: string[]): Promise<any> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (b) => (stdout += b.toString()));
      child.stderr?.on("data", (b) => (stderr += b.toString()));
      child.on("error", reject);
      child.on("exit", (code) => {
        const parsed = tryJson(stdout);
        if (code === 0 && parsed?.ok !== false) {
          resolvePromise(parsed ?? { ok: true, stdout });
          return;
        }
        reject(new Error(parsed?.error ?? (stderr.trim() || stdout.trim() || `helper ${args[0]} failed (${code})`)));
      });
    });
  }
}

function readPtyHandshake(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("pty handshake timed out"));
    }, 8000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`pty-spawn exited before handshake (${code})`));
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      cleanup();
      const line = buf.slice(0, nl).trim();
      try {
        const parsed = JSON.parse(line);
        if (parsed?.ok && parsed.pid) resolve(Number(parsed.pid));
        else reject(new Error(parsed?.error ?? `pty handshake failed: ${line}`));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function tryJson(text: string): any {
  const line = text.trim().split("\n").filter(Boolean).at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
