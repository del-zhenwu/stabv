import { dirname, resolve } from "node:path";
import { planLaunch } from "./adapters.ts";
import { previewRisk } from "./capabilities.ts";
import { expandSuiteCases, loadDocument, loadExperimentFile, loadRunnable, loadSuiteFile, loadWorkflowFile } from "./compose.ts";
import { HelperClient } from "./helper.ts";
import { faultLabel, validateExperiment, type Experiment, type Fault } from "./spec.ts";
import { resolveFixture } from "./workspace.ts";

export type DryRunPlan = {
  dryRun: true;
  kind: string;
  file: string;
  name: string;
  experiments?: DryRunExperiment[];
  tasks?: { type: string; experiments: DryRunExperiment[] }[];
  failFast?: boolean;
} & Partial<DryRunExperiment>;

export type DryRunExperiment = {
  file: string;
  name: string;
  adapter: string;
  command: string[];
  fixture?: string;
  fixturePath?: string;
  git: boolean;
  timeoutMs: number;
  recovery: { restart: boolean; resume: boolean };
  pty: boolean;
  mode: "rules" | "auto";
  budget?: number;
  faults: { label: string; atMs: number; durationMs?: number; when?: string }[];
  assertions: string[];
  risk: ReturnType<typeof previewRisk>;
  errors: string[];
};

export async function dryRunSpec(specPath: string): Promise<{ ok: boolean; plan: DryRunPlan }> {
  const resolved = resolve(specPath);
  const caps = await helperCaps();
  const { kind } = await loadDocument(resolved);
  if (kind === "Workload" || kind === "ChaosProfile") {
    return {
      ok: false,
      plan: {
        dryRun: true,
        kind,
        file: resolved,
        name: kind,
        errors: [`${kind} cannot be dry-run alone; write target.adapter + inject in one Experiment`],
        adapter: "",
        command: [],
        git: false,
        timeoutMs: 0,
        recovery: { restart: false, resume: false },
        pty: false,
        mode: "rules",
        faults: [],
        assertions: [],
        risk: previewRisk(
          { faults: [], target: { adapter: "generic-cli", pty: false }, recovery: { restart: false, resume: false } } as Experiment,
          caps,
        ),
      },
    };
  }
  if (kind === "Workflow") {
    const workflow = await loadWorkflowFile(resolved);
    const tasks = [];
    for (const task of workflow.tasks) {
      const experiments = [];
      for (const rel of task.experiments) {
        experiments.push(await describeExperiment(resolve(dirname(resolved), rel), caps));
      }
      tasks.push({ type: task.type, experiments });
    }
    const ok = tasks.every((t) => t.experiments.every((e) => e.errors.length === 0));
    return {
      ok,
      plan: { dryRun: true, kind, file: resolved, name: workflow.name, failFast: workflow.failFast, tasks },
    };
  }
  const runnable = kind === "Suite"
    ? { kind: "suite" as const, suite: await loadSuiteFile(resolved) }
    : await loadRunnable(resolved);
  if (runnable.kind === "suite") {
    const experiments = [];
    for (const item of await expandSuiteCases(runnable.suite)) {
      experiments.push(item.specPath
        ? await describeExperiment(item.specPath, caps)
        : describeLoaded(item.rel, item.exp, caps));
    }
    const ok = experiments.every((e) => e.errors.length === 0);
    return { ok, plan: { dryRun: true, kind: "Suite", file: resolved, name: runnable.suite.name, experiments } };
  }
  const exp = describeLoaded(resolved, runnable.exp, caps);
  return {
    ok: exp.errors.length === 0,
    plan: { dryRun: true, kind: "Experiment", ...exp },
  };
}

function describeLoaded(file: string, exp: Experiment, caps: string[]): DryRunExperiment {
  const errors = validateExperiment(exp);
  const plan = planLaunch(exp);
  const risk = previewRisk(exp, caps);
  if (risk.status === "unsupported") errors.push(`unsupported capability: ${risk.notes.join("; ")}`);
  let fixturePath: string | undefined;
  if (exp.fixture) {
    try {
      fixturePath = resolveFixture(exp.fixture);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    file,
    name: exp.name,
    adapter: exp.target.adapter,
    command: [plan.executable, ...plan.args],
    fixture: exp.fixture,
    fixturePath,
    git: exp.git,
    timeoutMs: exp.timeoutMs,
    recovery: exp.recovery,
    pty: Boolean(exp.target.pty),
    mode: exp.mode,
    budget: exp.budget,
    faults: exp.faults.map((f: Fault) => ({
      label: faultLabel(f),
      atMs: f.atMs,
      durationMs: f.durationMs,
      when: f.when,
    })),
    assertions: exp.assertions.map((a) => a.type),
    risk,
    errors,
  };
}

async function describeExperiment(specPath: string, caps: string[]): Promise<DryRunExperiment> {
  const file = resolve(specPath);
  try {
    return describeLoaded(file, await loadExperimentFile(file), caps);
  } catch (err) {
    return {
      file,
      name: file,
      adapter: "",
      command: [],
      git: false,
      timeoutMs: 0,
      recovery: { restart: false, resume: false },
      pty: false,
      mode: "rules",
      faults: [],
      assertions: [],
      risk: previewRisk(
        { faults: [], target: { adapter: "generic-cli", pty: false }, recovery: { restart: false, resume: false } } as Experiment,
        caps,
      ),
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}

async function helperCaps(): Promise<string[]> {
  try {
    return ((await HelperClient.discover().caps()) as { capabilities?: string[] }).capabilities ?? [];
  } catch {
    return [];
  }
}
