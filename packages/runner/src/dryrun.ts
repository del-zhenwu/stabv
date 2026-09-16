import { dirname, resolve } from "node:path";
import { planLaunch } from "./adapters.ts";
import { previewRisk } from "./capabilities.ts";
import { loadDocument, loadExperimentFile, loadSuiteFile, loadWorkflowFile } from "./compose.ts";
import { HelperClient } from "./helper.ts";
import { faultLabel, validateExperiment, type Experiment, type Fault } from "./spec.ts";

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
  git: boolean;
  timeoutMs: number;
  recovery: { restart: boolean; resume: boolean };
  pty: boolean;
  faults: { label: string; atMs: number; durationMs?: number }[];
  assertions: string[];
  risk: ReturnType<typeof previewRisk>;
  errors: string[];
};

export async function dryRunSpec(specPath: string): Promise<{ ok: boolean; plan: DryRunPlan }> {
  const resolved = resolve(specPath);
  const { kind } = await loadDocument(resolved);
  const caps = await helperCaps();
  if (kind === "Suite") {
    const suite = await loadSuiteFile(resolved);
    const experiments = [];
    for (const rel of suite.experiments) {
      experiments.push(await describeExperiment(resolve(dirname(resolved), rel), caps));
    }
    const ok = experiments.every((e) => e.errors.length === 0);
    return { ok, plan: { dryRun: true, kind, file: resolved, name: suite.name, experiments } };
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
  if (kind === "Workload" || kind === "ChaosProfile") {
    return {
      ok: false,
      plan: {
        dryRun: true,
        kind,
        file: resolved,
        name: kind,
        errors: [`${kind} cannot be dry-run alone; reference it from an Experiment`],
        adapter: "",
        command: [],
        git: false,
        timeoutMs: 0,
        recovery: { restart: false, resume: false },
        pty: false,
        faults: [],
        assertions: [],
        risk: previewRisk(
          { faults: [], target: { adapter: "generic-cli", pty: false }, recovery: { restart: false, resume: false } } as Experiment,
          caps,
        ),
      },
    };
  }
  const exp = await describeExperiment(resolved, caps);
  return {
    ok: exp.errors.length === 0,
    plan: { dryRun: true, kind: "Experiment", ...exp },
  };
}

async function describeExperiment(specPath: string, caps: string[]): Promise<DryRunExperiment> {
  const file = resolve(specPath);
  try {
    const exp = await loadExperimentFile(file);
    const errors = validateExperiment(exp);
    const plan = planLaunch(exp);
    return {
      file,
      name: exp.name,
      adapter: exp.target.adapter,
      command: [plan.executable, ...plan.args],
      fixture: exp.fixture,
      git: exp.git,
      timeoutMs: exp.timeoutMs,
      recovery: exp.recovery,
      pty: Boolean(exp.target.pty),
      faults: exp.faults.map((f: Fault) => ({ label: faultLabel(f), atMs: f.atMs, durationMs: f.durationMs })),
      assertions: exp.assertions.map((a) => a.type),
      risk: previewRisk(exp, caps),
      errors,
    };
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
