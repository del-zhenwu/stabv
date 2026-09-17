import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";

export async function workspaceFingerprint(work: string): Promise<string> {
  const files = await listFiles(work);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file);
    try {
      hash.update(await readFile(join(work, file)));
    } catch {
      hash.update("unreadable");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

async function listFiles(dir: string, acc: string[] = [], root = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (rel.split(/[\\/]/).includes(".git")) continue;
    if (entry.isDirectory()) await listFiles(full, acc, root);
    else acc.push(rel);
  }
  return acc;
}

export async function gitPorcelain(work: string): Promise<{ ok: boolean; text: string; head?: string; worktrees?: number; worktreesLocked?: boolean }> {
  const status = await gitOut(work, ["status", "--porcelain=v1"]);
  if (!status.ok) return { ok: false, text: status.text };
  const head = await gitOut(work, ["rev-parse", "HEAD"]);
  const wt = await gitWorktrees(work);
  return { ok: true, text: status.text, head: head.text.trim(), worktrees: wt.count, worktreesLocked: wt.locked };
}

export async function gitWorktrees(work: string): Promise<{ ok: boolean; count: number; locked: boolean; paths: string[] }> {
  const out = await gitOut(work, ["worktree", "list", "--porcelain"]);
  if (!out.ok) return { ok: false, count: 0, locked: false, paths: [] };
  const paths: string[] = [];
  let locked = false;
  for (const line of out.text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("worktree ")) {
      paths.push(trimmed.slice("worktree ".length).trim());
    } else if (trimmed.startsWith("locked")) {
      locked = true;
    }
  }
  return { ok: true, count: paths.length, locked, paths };
}

function gitOut(cwd: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout?.on("data", (b) => (text += b.toString()));
    child.stderr?.on("data", (b) => (text += b.toString()));
    child.on("error", (err) => resolve({ ok: false, text: String(err) }));
    child.on("exit", (code) => resolve({ ok: code === 0, text }));
  });
}

export function toolCallId(event: Record<string, unknown>): string | undefined {
  const nested = event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : undefined;
  const id = event.toolCallId ?? event.call_id ?? event.tool_call_id ?? nested?.id ?? (typeof event.type === "string" && /tool/i.test(event.type) ? event.id : undefined);
  return typeof id === "string" ? id : undefined;
}

export async function runVerify(work: string, executable: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: work, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout?.on("data", (b) => (output += b.toString()));
    child.stderr?.on("data", (b) => (output += b.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

export function envSnapshot(): Record<string, string> {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
