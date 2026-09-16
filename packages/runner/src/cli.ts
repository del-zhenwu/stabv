#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, watch as watchFs } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { normalizeSpec, validateExperiment } from "./spec.ts";
import { runExperiment } from "./runner.ts";
import { discoverAgents } from "./adapters.ts";
import { HelperClient } from "./helper.ts";
import { repoRoot } from "./paths.ts";
import { loadDocument, loadExperimentFile, loadSuiteFile, loadWorkflowFile } from "./compose.ts";
import { previewRisk } from "./capabilities.ts";
import { runSuite } from "./suite.ts";
import { runWorkflow } from "./workflow.ts";
import { dryRunSpec } from "./dryrun.ts";

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }
  let parsed: { positional: string[]; flags: Flags };
  try {
    parsed = parseFlags(rest);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const { positional, flags } = parsed;
  switch (cmd) {
    case "setup":
      return await setupCmd();
    case "init":
      return await initCmd();
    case "validate":
      return await validateCmd(positional[0]);
    case "run":
      return await runCmd(positional[0], flags);
    case "suite":
      return await suiteCmd(positional[0], flags);
    case "workflow":
      return await workflowCmd(positional[0], flags);
    case "watch":
      return await watchCmd(positional[0]);
    case "replay":
      return await replayCmd(positional[0], flags.repeat);
    case "list":
      return await listCmd();
    case "view":
      return await viewCmd(flags);
    case "report":
      return await reportCmd(positional[0], flags);
    case "recover":
      return await recoverCmd(positional[0]);
    default:
      console.error(`unknown command ${cmd}`);
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  console.log(`agentchaos <command>

  Windows: .\\agentchaos.cmd <command>
  Unix:    ./agentchaos <command>

  setup                install helper, discover agents (first-time)
                       Windows: scripts\\setup.cmd   Unix: ./scripts/setup.sh
  init                 rediscover agents and helper capabilities
  validate <spec>      check schema, capabilities, and risk
                       Suite/Workflow: validates every referenced experiment too
  run <spec> [--repeat N] [--dry-run] [--continue]
                       run Experiment, Suite, or Workflow
                       --dry-run prints the plan (command, faults, risk) without starting the agent
                       --continue keeps a Workflow going after a failed step
  suite <suite.yaml> [--repeat N] [--dry-run]
                       run a list of experiments with pass^k
  workflow <workflow.yaml> [--dry-run] [--continue]
                       run serial/parallel tasks
  view [--port 8080] [--open]
                       local report viewer (auto-refreshes)
  watch <run-id>       follow events.jsonl
  replay <run-id> [--repeat N]
                       re-run the spec saved with that run
  list                 recent runs
  report <run-id> [--open] [--json]
                       print a summary; --json prints report.json; --open launches HTML
  recover <run-id>     kill leftover process tree
`);
}

type Flags = { repeat?: number; port?: number; host?: string; open?: boolean; json?: boolean; dryRun?: boolean; continue?: boolean };

const KNOWN_FLAGS = new Set(["--repeat", "--port", "--host", "--open", "--json", "--dry-run", "--continue"]);

export function parseFlags(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  const unknown: string[] = [];
  const num = (name: string, value: string | undefined): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`invalid value for ${name}: ${value}`);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repeat") flags.repeat = num("--repeat", args[++i]);
    else if (arg.startsWith("--repeat=")) flags.repeat = num("--repeat", arg.slice("--repeat=".length));
    else if (arg === "--port") flags.port = num("--port", args[++i]);
    else if (arg.startsWith("--port=")) flags.port = num("--port", arg.slice("--port=".length));
    else if (arg === "--host") flags.host = args[++i];
    else if (arg.startsWith("--host=")) flags.host = arg.slice("--host=".length);
    else if (arg === "--open") flags.open = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--continue") flags.continue = true;
    else if (arg.startsWith("-") && arg !== "-") unknown.push(arg);
    else positional.push(arg);
  }
  if (unknown.length) {
    throw new Error(`unknown flag(s): ${unknown.join(", ")}\nsupported flags: ${[...KNOWN_FLAGS].join(", ")}`);
  }
  return { positional, flags };
}

async function setupCmd(): Promise<number> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    console.error(`Node.js 22+ required (found ${process.version})`);
    return 1;
  }
  console.log("building agentchaos-helper");
  const cargo = spawnSync("cargo", ["build", "-p", "agentchaos-helper"], { stdio: "inherit" });
  if (cargo.status !== 0) {
    console.error("helper build failed. Install Rust from https://rustup.rs and retry.");
    return 1;
  }
  const code = await initCmd();
  if (code !== 0) return code;
  const runSmoke =
    process.platform === "win32"
      ? ".\\agentchaos.cmd run examples\\codex-smoke.yaml"
      : "./agentchaos run examples/codex-smoke.yaml";
  const view =
    process.platform === "win32" ? ".\\agentchaos.cmd view --open" : "./agentchaos view --open";
  console.log(`
Ready.

  ${runSmoke}
  ${view}
`);
  return 0;
}

async function initCmd(): Promise<number> {
  const helper = HelperClient.discover();
  const caps = await helper.caps();
  const agents = discoverAgents();
  const out = { helper: { path: helper.path, caps }, agents };
  const dir = resolve(repoRoot(), ".agentchaos");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "capabilities.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function helperCapabilities(): Promise<string[]> {
  try {
    return ((await HelperClient.discover().caps()) as { capabilities?: string[] }).capabilities ?? [];
  } catch {
    return [];
  }
}

async function validateCmd(specPath?: string): Promise<number> {
  if (!specPath) {
    console.error("usage: agentchaos validate <spec.yaml>");
    return 2;
  }
  const resolved = resolve(specPath);
  try {
    const { kind } = await loadDocument(resolved);
    if (kind === "Suite") return await validateSuite(resolved);
    if (kind === "Workflow") return await validateWorkflow(resolved);
    if (kind === "Workload" || kind === "ChaosProfile") return await validateFragment(resolved, kind);
    return await validateExperimentFile(resolved);
  } catch (err) {
    console.error(`${resolved}: ${formatError(err)}`);
    return 1;
  }
}

async function validateExperimentFile(resolved: string): Promise<number> {
  const exp = await loadExperimentFile(resolved);
  const errors = validateExperiment(exp);
  const risk = previewRisk(exp, await helperCapabilities());
  if (errors.length) {
    console.error(`${resolved}:\n${errors.join("\n")}`);
    console.log(JSON.stringify({ ok: false, file: resolved, errors, risk }, null, 2));
    return 1;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        file: resolved,
        name: exp.name,
        adapter: exp.target.adapter,
        faults: exp.faults.map((f) => `${f.kind}.${f.action}`),
        risk,
      },
      null,
      2,
    ),
  );
  return risk.status === "unsupported" ? 1 : 0;
}

async function validateSuite(resolved: string): Promise<number> {
  const suite = await loadSuiteFile(resolved);
  const caps = await helperCapabilities();
  const baseDir = dirname(resolved);
  const results = [];
  for (const rel of suite.experiments) {
    results.push(await checkReferencedExperiment(resolve(baseDir, rel), rel, caps));
  }
  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, kind: "Suite", file: resolved, name: suite.name, repeat: suite.repeat, experiments: results }, null, 2));
  return ok ? 0 : 1;
}

async function validateWorkflow(resolved: string): Promise<number> {
  const workflow = await loadWorkflowFile(resolved);
  const caps = await helperCapabilities();
  const baseDir = dirname(resolved);
  const results = [];
  for (const task of workflow.tasks) {
    for (const rel of task.experiments) {
      results.push({ task: task.type, ...(await checkReferencedExperiment(resolve(baseDir, rel), rel, caps)) });
    }
  }
  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, kind: "Workflow", file: resolved, name: workflow.name, experiments: results }, null, 2));
  return ok ? 0 : 1;
}

async function checkReferencedExperiment(
  specPath: string,
  rel: string,
  caps: string[],
): Promise<{ file: string; ok: boolean; errors: string[]; faults?: string[] }> {
  try {
    const exp = await loadExperimentFile(specPath);
    const errors = validateExperiment(exp);
    return { file: rel, ok: errors.length === 0, errors, faults: exp.faults.map((f) => `${f.kind}.${f.action}`) };
  } catch (err) {
    return { file: rel, ok: false, errors: [`${specPath}: ${formatError(err)}`] };
  }
}

async function validateFragment(resolved: string, kind: "Workload" | "ChaosProfile"): Promise<number> {
  const { raw } = await loadDocument(resolved);
  const spec = raw?.spec ?? {};
  const errors: string[] = [];
  if (kind === "Workload") {
    if (!spec.target && !spec.fixture && !spec.verify) {
      errors.push("Workload needs spec.target (or spec.fixture)");
    }
  } else {
    if (!Array.isArray(spec.faults) || spec.faults.length === 0) {
      errors.push("ChaosProfile needs a non-empty spec.faults list");
    }
  }
  if (!errors.length) {
    // Reuse experiment normalization to surface unknown fault types, bad paths, etc.
    const merged = {
      apiVersion: raw.apiVersion ?? "agentchaos.dev/v1alpha1",
      kind: "Experiment",
      metadata: raw.metadata,
      spec: {
        // benign target so experiment-level target checks do not fire for fragments
        target: { adapter: "generic-cli", executable: "agentchaos-fragment-check" },
        ...spec,
        faults: kind === "ChaosProfile" ? spec.faults : [],
        perturbations: spec.perturbations,
      },
    };
    try {
      const exp = normalizeSpec(merged);
      errors.push(...validateExperiment(exp));
    } catch (err) {
      errors.push(formatError(err));
    }
  }
  if (errors.length) {
    console.error(`${resolved}:\n${errors.join("\n")}`);
    console.log(JSON.stringify({ ok: false, kind, file: resolved, errors }, null, 2));
    return 1;
  }
  console.log(JSON.stringify({ ok: true, kind, file: resolved, name: raw?.metadata?.name ?? kind }, null, 2));
  return 0;
}

async function runCmd(specPath?: string, flags: Flags = {}): Promise<number> {
  if (!specPath) {
    console.error("usage: agentchaos run <spec.yaml> [--repeat N] [--dry-run] [--continue]");
    return 2;
  }
  if (flags.dryRun) return printDryRun(specPath);
  const resolved = resolve(specPath);
  const { kind } = await loadDocument(resolved);
  if (kind === "Suite") return suiteCmd(resolved, flags);
  if (kind === "Workflow") return workflowCmd(resolved, flags);
  if (kind === "Workload" || kind === "ChaosProfile") {
    console.error(`${kind} cannot be run alone; reference it from an Experiment (see examples/composed.yaml)`);
    return 2;
  }
  const exp = await loadExperimentFile(resolved);
  const errors = validateExperiment(exp);
  if (errors.length) {
    console.error(errors.join("\n"));
    return 1;
  }
  const n = Math.max(1, flags.repeat ?? 1);
  let passed = 0;
  let lastCode = 1;
  for (let i = 1; i <= n; i++) {
    if (n > 1) console.log(`trial ${i}/${n}`);
    const result = await runExperiment(exp, resolved);
    lastCode = result.exitCode;
    if (result.report.passed) passed += 1;
  }
  if (n > 1) {
    const passHatK = passed === n;
    console.log(JSON.stringify({ repeat: n, passed, passHatK }, null, 2));
    return passHatK ? 0 : 1;
  }
  return lastCode;
}

async function suiteCmd(specPath?: string, flags: Flags = {}): Promise<number> {
  if (!specPath) {
    console.error("usage: agentchaos suite <suite.yaml> [--repeat N] [--dry-run]");
    return 2;
  }
  if (flags.dryRun) return printDryRun(specPath);
  const suite = await loadSuiteFile(resolve(specPath));
  const report = await runSuite(suite, { repeat: flags.repeat });
  return report.passed ? 0 : 1;
}

async function workflowCmd(specPath?: string, flags: Flags = {}): Promise<number> {
  if (!specPath) {
    console.error("usage: agentchaos workflow <workflow.yaml> [--dry-run] [--continue]");
    return 2;
  }
  if (flags.dryRun) return printDryRun(specPath);
  const workflow = await loadWorkflowFile(resolve(specPath));
  const report = await runWorkflow(workflow, { failFast: flags.continue ? false : undefined });
  return report.passed ? 0 : 1;
}

async function printDryRun(specPath: string): Promise<number> {
  const { ok, plan } = await dryRunSpec(specPath);
  console.log(JSON.stringify(plan, null, 2));
  return ok ? 0 : 1;
}

async function watchCmd(runId?: string): Promise<number> {
  if (!runId) {
    console.error("usage: agentchaos watch <run-id>");
    return 2;
  }
  const eventsPath = findRunFile(runId, "events.jsonl");
  if (!eventsPath) {
    console.error(`events not found for ${runId}`);
    return 1;
  }
  let offset = 0;
  const printNew = async () => {
    const text = await readFile(eventsPath, "utf8");
    if (text.length <= offset) return false;
    const chunk = text.slice(offset);
    offset = text.length;
    process.stdout.write(chunk);
    return /"event":"run_finished"/.test(chunk);
  };
  if (await printNew()) return 0;
  await new Promise<void>((resolveWatch) => {
    const watcher = watchFs(dirname(eventsPath), async () => {
      if (await printNew()) {
        watcher.close();
        resolveWatch();
      }
    });
    setTimeout(() => {
      watcher.close();
      resolveWatch();
    }, 30 * 60 * 1000);
  });
  return 0;
}

async function replayCmd(runId?: string, repeat?: number): Promise<number> {
  if (!runId) {
    console.error("usage: agentchaos replay <run-id>");
    return 2;
  }
  const specPath = findRunFile(runId, "experiment.json");
  if (!specPath) {
    console.error(`experiment.json not found for ${runId}; cannot replay`);
    return 1;
  }
  return runCmd(specPath, { repeat });
}

async function listCmd(): Promise<number> {
  const index = resolve(process.cwd(), ".agentchaos-runs", "index.jsonl");
  const alt = resolve(repoRoot(), ".agentchaos-runs", "index.jsonl");
  const path = existsSync(index) ? index : existsSync(alt) ? alt : undefined;
  if (!path) {
    console.log("[]");
    return 0;
  }
  const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  const rows: unknown[] = [];
  for (const line of lines.slice(-20)) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      console.error(`skipping corrupt index line: ${line.slice(0, 80)}`);
    }
  }
  console.log(JSON.stringify(rows, null, 2));
  return 0;
}

async function viewCmd(flags: Flags): Promise<number> {
  const viewer = await startViewer({ host: flags.host, port: flags.port ?? 8080 });
  console.log(`viewer ${viewer.url}`);
  if (flags.open) openBrowser(viewer.url);
  await new Promise<void>((resolveWait) => {
    const stop = () => {
      void viewer.close().finally(() => resolveWait());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function reportCmd(runId?: string, flags: Flags = {}): Promise<number> {
  if (!runId) {
    console.error("usage: agentchaos report <run-id> [--open] [--json]");
    return 2;
  }
  const jsonPath = findRunFile(runId, "report.json");
  if (!jsonPath) {
    console.error(`report not found for ${runId}`);
    return 1;
  }
  const htmlPath = findRunFile(runId, "report.html");
  if (flags.json) {
    process.stdout.write(await readFile(jsonPath, "utf8"));
  } else {
    printReportSummary(JSON.parse(await readFile(jsonPath, "utf8")));
  }
  if (htmlPath) console.error(`html ${htmlPath}`);
  if (flags.open && htmlPath) openBrowser(`file://${htmlPath}`);
  return 0;
}

function printReportSummary(report: any): void {
  const lines: string[] = [];
  const pill = (ok: boolean) => (ok ? "PASS" : "FAIL");
  lines.push(`${pill(Boolean(report.passed))}  ${report.name ?? report.id}  (${report.id})`);
  lines.push(`  exit=${report.result?.code ?? "null"} signal=${report.result?.signal ?? "none"} timedOut=${Boolean(report.result?.timedOut)}`);
  lines.push(`  duration=${report.metrics?.durationMs ?? "?"}ms  injected=${(report.injected ?? []).join(", ") || "none"}`);
  const m = report.metrics;
  if (m) {
    lines.push(
      `  recovery=${Math.round((m.recoveryRate ?? 0) * 100)}%  mttr=${m.mttrMs != null ? `${m.mttrMs}ms` : "—"}  orphans=${m.orphanCount ?? 0}  dupTools=${m.duplicateToolIds?.length ?? 0}  diverge=${m.stateDivergence ? "yes" : "no"}  takeover=${m.userInterventionCount ?? 0}`,
    );
  }
  lines.push("  checks:");
  for (const check of report.checks ?? []) {
    lines.push(`    ${check.passed ? "ok  " : "FAIL"} ${check.assertion}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  console.log(lines.join("\n"));
}

async function recoverCmd(runId?: string): Promise<number> {
  if (!runId) {
    console.error("usage: agentchaos recover <run-id>");
    return 2;
  }
  const pidPath = findRunFile(runId, "agent.pid");
  if (!pidPath) {
    console.error(`run ${runId} not found`);
    return 1;
  }
  const pid = Number((await readFile(pidPath, "utf8")).trim());
  if (!pid) {
    console.log("no pid recorded");
    return 0;
  }
  const helper = HelperClient.discover();
  const tree = await helper.killTree(pid);
  console.log(JSON.stringify({ ok: true, tree }, null, 2));
  return 0;
}

function findRunFile(runId: string, file: string): string | undefined {
  const roots = [resolve(process.cwd(), ".agentchaos-runs", runId, file), resolve(repoRoot(), ".agentchaos-runs", runId, file)];
  return roots.find((p) => existsSync(p));
}

try {
  const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  if (invokedAsScript) process.exit(await main());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
