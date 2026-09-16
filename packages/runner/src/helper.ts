import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { repoRoot } from "./paths.ts";

export type HelperTree = {
  root: number;
  alive: boolean;
  processes: { pid: number; ppid: number; command: string }[];
};

export class HelperClient {
  private bin: string;
  constructor(bin: string) {
    this.bin = bin;
  }

  static discover(root = repoRoot()): HelperClient {
    const exe = process.platform === "win32" ? "agentchaos-helper.exe" : "agentchaos-helper";
    const candidates = [
      process.env.AGENTCHAOS_HELPER,
      resolve(root, "target/debug", exe),
      resolve(root, "target/release", exe),
      resolve(root, "helper/target/debug", exe),
      resolve(root, "helper/bin", exe),
    ].filter((x): x is string => Boolean(x));
    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      throw new Error(
        `agentchaos-helper not found. Build it with \`cargo build -p agentchaos-helper\` (looked in ${candidates.join(", ")})`,
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

  async pauseTree(pid: number): Promise<HelperTree> {
    const json = await this.run(["pause-tree", String(pid)]);
    return json.tree as HelperTree;
  }

  async resumeTree(pid: number): Promise<HelperTree> {
    const json = await this.run(["resume-tree", String(pid)]);
    return json.tree as HelperTree;
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
