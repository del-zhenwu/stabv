#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, watch as watchFs } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { normalizeSpec, validateExperiment, type Experiment } from "./spec.ts";
import { runExperiment } from "./runner.ts";
import { discoverAgents, planLaunch } from "./adapters.ts";
import { HelperClient } from "./helper.ts";
import { repoRoot } from "./paths.ts";
import { DEFAULT_INJECT } from "./inject.ts";
import { expandSuiteCases, loadComposedExperiment, loadDocument, loadExperimentFile, loadRunnable, loadSuiteFile, loadWorkflowFile } from "./compose.ts";
import { previewRisk } from "./capabilities.ts";
import { runSuite } from "./suite.ts";
import { runWorkflow } from "./workflow.ts";
import { dryRunSpec } from "./dryrun.ts";
import { startViewer, collectRuns, runsRoot, openBrowser } from "./view.ts";
import { resolveFixture } from "./workspace.ts";

function loadDotenvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

function loadLocalDotenv(): void {
  loadDotenvFile(resolve(process.cwd(), ".env"));
  const root = repoRoot();
  if (root !== process.cwd()) loadDotenvFile(resolve(root, ".env"));
}

async function main(): Promise<number> {
  loadLocalDotenv();
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

  Install: npm install -g agentchaos
  Then:    agentchaos run examples/zcode.yaml
           agentchaos view --open

  setup                contributor: check helper
  init                 optional: write ./agentchaos.yaml without running
  validate [spec]      check schema and risk (default: ./agentchaos.yaml)
  run [spec] [--repeat N] [--dry-run] [--continue]
                       default spec: examples/zcode.yaml (zcode + all inject kinds)
  suite <suite.yaml> [--repeat N] [--dry-run]
  workflow <workflow.yaml> [--dry-run] [--continue]
  view [--port 8080] [--open]
  watch <run-id>
  replay <run-id> [--repeat N]
  list
  report <id> [--open] [--json]
  recover <run-id>
`);
}

type Flags = {
  repeat?: number;
  port?: number;
  host?: string;
  open?: boolean;
  json?: boolean;
  dryRun?: boolean;
  continue?: boolean;
  workload?: string;
  profile?: string;
};

const KNOWN_FLAGS = new Set([
  "--repeat",
  "--port",
  "--host",
  "--open",
  "--json",
  "--dry-run",
  "--continue",
  "--workload",
  "--profile",
]);

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
    else if (arg === "--workload") flags.workload = args[++i];
    else if (arg.startsWith("--workload=")) flags.workload = arg.slice("--workload=".length);
    else if (arg === "--profile") flags.profile = args[++i];
    else if (arg.startsWith("--profile=")) flags.profile = arg.slice("--profile=".length);
    else if (arg.startsWith("-") && arg !== "-") unknown.push(arg);
    else positional.push(arg);
  }
  if (unknown.length) {
    throw new Error(`unknown flag(s): ${unknown.join(", ")}\nsupported flags: ${[...KNOWN_FLAGS].join(", ")}`);
  }
  return { positional, flags };
}

export const STARTER_SPEC_NAME = "agentchaos.yaml";

function starterYaml(): string {
  const inject = DEFAULT_INJECT.map((kind) => `    - ${kind}`).join("\n");
  return `# 谁在跑 + 打哪类故障。系统自己展开组合。
# fixture: broken-sum 是安装包自带的示例工程（src/sum.js 故意算错）。
# 运行时拷进 .agentchaos-runs/<id>/workspace/，不会改你当前目录。
# 测自己的代码：把 fixture 改成工程的绝对路径。
spec:
  target:
    adapter: zcode
    prompt: "Fix src/sum.js so \`node --test\` passes."
    json: true
    bypassApprovals: true
  fixture: broken-sum
  timeout: 3m
  inject:
${inject}
`;
}

export async function writeStarterSpec(cwd = process.cwd()): Promise<{ path: string; created: boolean; adapter: string }> {
  const dest = resolve(cwd, STARTER_SPEC_NAME);
  if (existsSync(dest)) return { path: dest, created: false, adapter: "zcode" };
  await writeFile(dest, starterYaml(), "utf8");
  return { path: dest, created: true, adapter: "zcode" };
}

function defaultSpecPath(): string {
  return resolve(process.cwd(), STARTER_SPEC_NAME);
}

function resolveUserSpec(specPath: string): string {
  const candidates = [
    resolve(specPath),
    resolve(process.cwd(), specPath),
    resolve(repoRoot(), specPath),
    resolve(repoRoot(), "examples", specPath),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`找不到实验文件: ${specPath}`);
  }
  return found;
}

async function setupCmd(): Promise<number> {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    console.error(`Node.js 22+ required (found ${process.version})`);
    return 1;
  }
  console.log("ensuring agentchaos-helper");
  const ensureArgs = [resolve(repoRoot(), "scripts/ensure-helper.mjs")];
  if (existsSync(resolve(repoRoot(), ".git"))) ensureArgs.push("--build");
  const ensure = spawnSync(process.execPath, ensureArgs, {
    stdio: "inherit",
  });
  if (ensure.status !== 0) {
    console.error("helper missing. If this is the npm package, it is incomplete. Do not install Rust to paper over it.");
    return 1;
  }
  const code = await initCmd();
  if (code !== 0) return code;
  console.log(`
Ready.

  agentchaos run examples/zcode.yaml
  agentchaos view --open
`);
  return 0;
}

async function initCmd(): Promise<number> {
  const helper = HelperClient.discover();
  const caps = await helper.caps();
  const agents = discoverAgents();
  const starter = await writeStarterSpec();
  const out = {
    helper: { path: helper.path, caps },
    agents,
    spec: { path: starter.path, created: starter.created, adapter: starter.adapter },
  };
  const dir = resolve(repoRoot(), ".agentchaos");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "capabilities.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  if (starter.created) {
    console.log(`wrote ${starter.path}`);
    console.log("fixture: broken-sum → bundled examples/fixtures/broken-sum (src/sum.js is intentionally wrong)");
  } else {
    console.log(`kept ${starter.path}`);
  }
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

async function ensureDefaultSpec(): Promise<{ path: string; created: boolean; adapter: string }> {
  const dest = defaultSpecPath();
  if (existsSync(dest)) return { path: dest, created: false, adapter: "" };
  return await writeStarterSpec();
}

async function validateCmd(specPath?: string): Promise<number> {
  if (!specPath) {
    const spec = await ensureDefaultSpec();
    specPath = spec.path;
    if (spec.created) {
      console.log(`wrote ${spec.path} (adapter: ${spec.adapter})`);
    }
  }
  let resolved: string;
  try {
    resolved = resolveUserSpec(specPath);
  } catch (err) {
    console.error(formatError(err));
    return 1;
  }
  try {
    const { kind } = await loadDocument(resolved);
    if (kind === "Suite") return await validateSuite(resolved);
    if (kind === "Workflow") return await validateWorkflow(resolved);
    if (kind === "Workload" || kind === "ChaosProfile") return await validateFragment(resolved, kind as "Workload" | "ChaosProfile");
    const runnable = await loadRunnable(resolved);
    if (runnable.kind === "suite") return await validateSuite(resolved, runnable.suite);
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
  if (risk.status === "unsupported") {
    console.error(`${resolved}: unsupported capability\n${risk.notes.join("\n")}`);
  }
  let fixturePath: string | undefined;
  if (exp.fixture) {
    try {
      fixturePath = resolveFixture(exp.fixture);
    } catch (err) {
      console.error(formatError(err));
      console.log(JSON.stringify({ ok: false, file: resolved, errors: [formatError(err)], risk }, null, 2));
      return 1;
    }
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        file: resolved,
        name: exp.name,
        adapter: exp.target.adapter,
        fixture: exp.fixture,
        fixturePath,
        faults: exp.faults.map((f) => `${f.kind}.${f.action}`),
        risk,
      },
      null,
      2,
    ),
  );
  return risk.status === "unsupported" ? 1 : 0;
}

async function validateSuite(resolved: string, preloaded?: import("./spec.ts").Suite): Promise<number> {
  const suite = preloaded ?? await loadSuiteFile(resolved);
  const caps = await helperCapabilities();
  const baseDir = dirname(resolved);
  const results = [];
  for (const rel of suite.experiments) {
    results.push(await checkReferencedExperiment(resolve(baseDir, rel), rel, caps));
  }
  try {
    for (const item of await expandSuiteCases({ ...suite, experiments: [] })) {
      const errors = validateExperiment(item.exp);
      const risk = previewRisk(item.exp, caps);
      const capabilityErrors = risk.status === "unsupported" ? [`unsupported capability: ${risk.notes.join("; ")}`] : [];
      results.push({
        file: item.rel,
        ok: errors.length === 0 && capabilityErrors.length === 0,
        errors: [...errors, ...capabilityErrors],
        faults: item.exp.faults.map((f) => `${f.kind}.${f.action}`),
        risk,
      });
    }
  } catch (err) {
    results.push({ file: suite.name, ok: false, errors: [formatError(err)] });
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
): Promise<{ file: string; ok: boolean; errors: string[]; faults?: string[]; risk?: ReturnType<typeof previewRisk> }> {
  try {
    const exp = await loadExperimentFile(specPath);
    const errors = validateExperiment(exp);
    const risk = previewRisk(exp, caps);
    const capabilityErrors = risk.status === "unsupported" ? [`unsupported capability: ${risk.notes.join("; ")}`] : [];
    return {
      file: rel,
      ok: errors.length === 0 && capabilityErrors.length === 0,
      errors: [...errors, ...capabilityErrors],
      faults: exp.faults.map((f) => `${f.kind}.${f.action}`),
      risk,
    };
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
    if (spec.mode !== "auto" && (!Array.isArray(spec.faults) || spec.faults.length === 0)) {
      errors.push("ChaosProfile needs spec.faults, or mode: auto");
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
  if (flags.workload || flags.profile) {
    return runComposed(specPath, flags);
  }
  if (!specPath) {
    const local = defaultSpecPath();
    specPath = existsSync(local) ? local : "examples/zcode.yaml";
  }
  try {
    specPath = resolveUserSpec(specPath);
  } catch (err) {
    console.error(formatError(err));
    return 1;
  }
  if (flags.dryRun) return printDryRun(specPath);
  const resolved = resolve(specPath);
  const runnable = await loadRunnable(resolved);
  if (runnable.kind === "suite") return suiteCmd(resolved, flags, runnable.suite);
  if (runnable.kind === "workflow") return workflowCmd(resolved, flags);
  return executeExperiment(runnable.exp, resolved, flags);
}

async function runComposed(specPath: string | undefined, flags: Flags): Promise<number> {
  let workload = flags.workload;
  let profile = flags.profile;
  if (specPath) {
    const resolved = resolve(specPath);
    const { kind } = await loadDocument(resolved);
    if (kind === "Workload") workload = workload ?? resolved;
    else if (kind === "ChaosProfile") profile = profile ?? resolved;
    else {
      console.error("run --workload/--profile does not take an Experiment/Suite file; omit the spec or pass a Workload/ChaosProfile");
      return 2;
    }
  }
  if (!workload || !profile) {
    console.error("usage: agentchaos run --workload <workload.yaml> --profile <profile.yaml>");
    return 2;
  }
  const exp = await loadComposedExperiment({ workload, profile, fromDir: process.cwd() });
  if (flags.dryRun) {
    const errors = validateExperiment(exp);
    const risk = previewRisk(exp, await helperCapabilities());
    const plan = planLaunch(exp);
    console.log(JSON.stringify({
      dryRun: true,
      kind: "Experiment",
      name: exp.name,
      adapter: exp.target.adapter,
      command: [plan.executable, ...plan.args],
      faults: exp.faults.map((f) => `${f.kind}.${f.action}`),
      assertions: exp.assertions.map((a) => a.type),
      errors,
      risk,
    }, null, 2));
    return errors.length || risk.status === "unsupported" ? 1 : 0;
  }
  return executeExperiment(exp, undefined, flags);
}

async function executeExperiment(exp: Experiment, specPath: string | undefined, flags: Flags): Promise<number> {
  const errors = validateExperiment(exp);
  if (errors.length) {
    console.error(errors.join("\n"));
    return 1;
  }
  const risk = previewRisk(exp, await helperCapabilities());
  if (risk.status === "unsupported") {
    console.error(`unsupported capability\n${risk.notes.join("\n")}`);
    console.log(JSON.stringify({ ok: false, file: specPath, errors: [], risk }, null, 2));
    return 1;
  }
  const n = Math.max(1, flags.repeat ?? 1);
  let passed = 0;
  let lastCode = 1;
  for (let i = 1; i <= n; i++) {
    if (n > 1) console.log(`trial ${i}/${n}`);
    const result = await runExperiment(exp, specPath);
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

async function suiteCmd(specPath?: string, flags: Flags = {}, preloaded?: import("./spec.ts").Suite): Promise<number> {
  if (!specPath && !preloaded) {
    console.error("usage: agentchaos suite <suite.yaml> [--repeat N] [--dry-run]");
    return 2;
  }
  if (flags.dryRun && specPath) return printDryRun(specPath);
  const suite = preloaded ?? await loadSuiteFile(resolve(specPath!));
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
  const reportPath = findRunFile(runId, "report.json");
  if (reportPath) {
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      const decisions = Array.isArray(report.autoDecisions) && report.autoDecisions.length > 0
        ? report.autoDecisions
        : report.nemesisDecisions;
      if (Array.isArray(decisions) && decisions.length > 0) {
        console.log(`[replay] Replaying recorded fault sequence (${decisions.length} strikes) from run ${runId}`);
        const exp = JSON.parse(await readFile(specPath, "utf8"));
        delete exp.nemesis;
        delete exp.chaos?.nemesis;
        exp.mode = "rules";
        const deterministicFaults = decisions.map((d: { fault: Record<string, unknown>; atMs: number }) => ({
          ...d.fault,
          at: `${d.atMs}ms`,
          atMs: d.atMs,
          duration: d.fault.durationMs ? `${d.fault.durationMs}ms` : undefined,
        }));
        exp.faults = deterministicFaults;
        if (exp.spec) {
          delete exp.spec.nemesis;
          delete exp.spec.chaos?.nemesis;
          exp.spec.mode = "rules";
          exp.spec.faults = deterministicFaults;
        }
        const replaySpecPath = join(dirname(specPath), "replay-spec.json");
        await writeFile(replaySpecPath, JSON.stringify(exp, null, 2));
        return runCmd(replaySpecPath, { repeat });
      }
    } catch {
      /* fall back to re-running original experiment */
    }
  }
  return runCmd(specPath, { repeat });
}

async function listCmd(): Promise<number> {
  const rows = collectRuns(runsRoot()).slice(0, 20).map((job) => ({
    id: job.id,
    name: job.name,
    kind: job.kind,
    passed: job.passed,
    status: job.status ?? "done",
    cases: job.cases,
    passedCases: job.passedCases,
    href: job.href,
    children: job.children?.map((child) => ({ id: child.id, name: child.name, passed: child.passed })),
  }));
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
    console.error("usage: agentchaos report <id> [--open] [--json]");
    return 2;
  }
  const jsonPath = findRunFile(runId, "suite.json") ?? findRunFile(runId, "workflow.json") ?? findRunFile(runId, "report.json");
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
  if (flags.open && htmlPath) {
    const url = await viewerReportUrl(runId);
    openBrowser(url ?? `file://${htmlPath}`);
  }
  return 0;
}

async function viewerReportUrl(runId: string): Promise<string | undefined> {
  try {
    const res = await fetch("http://127.0.0.1:8080/api/runs", { signal: AbortSignal.timeout(400) });
    if (!res.ok) return undefined;
    const jobs = (await res.json()) as Array<{ id: string; href: string; children?: Array<{ id: string }> }>;
    for (const job of jobs) {
      if (job.id === runId || job.href.includes(runId)) return `http://127.0.0.1:8080${job.href}`;
      if (job.children?.some((child) => child.id === runId)) return `http://127.0.0.1:8080${job.href}`;
    }
    return `http://127.0.0.1:8080/runs/${runId}/report.html`;
  } catch {
    return undefined;
  }
}

function printReportSummary(report: any): void {
  if (Array.isArray(report.trials)) {
    printSuiteSummary(report);
    return;
  }
  if (Array.isArray(report.steps)) {
    printWorkflowSummary(report);
    return;
  }
  const lines: string[] = [];
  const classified = report.verdict ?? (Array.isArray(report.checks) && report.checks.some((c: { assertion?: string; passed?: boolean }) => String(c.assertion ?? "").startsWith("fault_injected:") && !c.passed) ? "inconclusive" : report.passed ? "pass" : "fail");
  const pill = classified === "pass" ? "PASS" : classified === "inconclusive" ? "N/A" : "FAIL";
  lines.push(`${pill}  ${report.name ?? report.id}  (${report.id})`);
  if (report.blockReason) lines.push(`  ${report.blockReason}`);
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

function printSuiteSummary(report: any): void {
  const pill = report.status === "running" ? "RUN" : report.passed ? "PASS" : "FAIL";
  const passed = (report.trials ?? []).filter((t: { passed: boolean }) => t.passed).length;
  const total = (report.trials ?? []).length;
  const lines = [`${pill}  ${report.name ?? report.id}  (suite ${report.id})`, `  cases=${passed}/${total}  repeat=${report.repeat ?? 1}`];
  for (const trial of report.trials ?? []) {
    lines.push(`    ${trial.passed ? "ok  " : "FAIL"} ${trial.name}  ${trial.runId}`);
  }
  console.log(lines.join("\n"));
}

function printWorkflowSummary(report: any): void {
  const pill = report.status === "running" ? "RUN" : report.passed ? "PASS" : "FAIL";
  const passed = (report.steps ?? []).filter((s: { passed: boolean }) => s.passed).length;
  const total = (report.steps ?? []).length;
  const lines = [`${pill}  ${report.name ?? report.id}  (workflow ${report.id})`, `  steps=${passed}/${total}`];
  for (const step of report.steps ?? []) {
    lines.push(`    ${step.passed ? "ok  " : "FAIL"} [${step.mode}] ${step.name}  ${step.runId}`);
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
  const names = [runId];
  if (!runId.startsWith("suite-")) names.push(`suite-${runId}`);
  if (!runId.startsWith("workflow-")) names.push(`workflow-${runId}`);
  const roots: string[] = [];
  for (const name of names) {
    roots.push(resolve(process.cwd(), ".agentchaos-runs", name, file));
    roots.push(resolve(repoRoot(), ".agentchaos-runs", name, file));
  }
  return roots.find((p) => existsSync(p));
}

try {
  const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  if (invokedAsScript) process.exit(await main());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
