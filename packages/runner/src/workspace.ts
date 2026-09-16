import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { repoRoot } from "./paths.ts";
import type { Experiment } from "./spec.ts";

export type PreparedWorkspace = {
  runRoot: string;
  work: string;
};

export async function prepareWorkspace(exp: Experiment, runId: string, repo = repoRoot()): Promise<PreparedWorkspace> {
  const runRoot = resolve(process.cwd(), exp.workspaceDir, runId);
  const work = join(runRoot, "workspace");
  await mkdir(work, { recursive: true });
  if (exp.fixture) {
    const fixture = resolveFixture(exp.fixture, repo);
    await cp(fixture, work, { recursive: true });
  } else {
    await writeFile(join(work, "README.md"), `# AgentChaos workspace\n\nrun: ${runId}\nexperiment: ${exp.name}\n`);
  }
  if (exp.git) await gitInit(work);
  return { runRoot, work };
}

function resolveFixture(fixture: string, repo: string): string {
  const candidates = [
    resolve(fixture),
    resolve(repo, fixture),
    resolve(repo, "examples/fixtures", fixture),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`fixture not found: ${fixture}`);
  return found;
}

export function assertInsideWorkspace(work: string, rel: string): string {
  const resolved = resolve(work, rel);
  const root = resolve(work);
  if (resolved !== root && !resolved.startsWith(root + "/") && !resolved.startsWith(root + "\\")) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return resolved;
}

async function gitInit(work: string): Promise<void> {
  await runGit(work, ["init"]);
  await runGit(work, ["-c", "user.email=chaos@agentchaos.dev", "-c", "user.name=AgentChaos", "add", "-A"]);
  await runGit(work, [
    "-c",
    "user.email=chaos@agentchaos.dev",
    "-c",
    "user.name=AgentChaos",
    "commit",
    "--allow-empty",
    "-m",
    "agentchaos fixture",
  ]);
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr?.on("data", (b) => (err += b.toString()));
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`git ${args.join(" ")} failed: ${err.trim()}`));
    });
    child.on("error", reject);
  });
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
