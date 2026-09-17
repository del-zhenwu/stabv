import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { existsSync } from "node:fs";
import { repoRoot } from "./paths.ts";
import { normalizeSpec, normalizeSuite, normalizeWorkflow, type Experiment, type Suite, type Workflow } from "./spec.ts";
import { faultLineNumbers } from "./yaml-loc.ts";
import { comboLabel, implicitWorkload, parseInject, resolveInjectProfiles } from "./inject.ts";

export async function loadDocument(specPath: string): Promise<{ kind: string; raw: any; text: string }> {
  const text = await readFile(specPath, "utf8");
  const raw = specPath.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return { kind: raw?.kind ?? "Experiment", raw, text };
}

export async function loadExperimentFile(specPath: string): Promise<Experiment> {
  const resolved = resolve(specPath);
  const { raw, text } = await loadDocument(resolved);
  if (raw?.kind === "Suite") throw new Error(`${specPath} is a Suite; use: agentchaos suite ${specPath}`);
  const expanded = await expandInjectRaw(raw, dirname(resolved));
  if (expanded.kind === "suite") throw new Error(`${specPath} expands to a suite; use: agentchaos run ${specPath}`);
  const merged = await composeRefs(expanded.raw, dirname(resolved));
  const exp = normalizeSpec(merged, {
    sourcePath: resolved,
    faultLines: resolved.endsWith(".json") ? [] : faultLineNumbers(text),
  });
  exp.sourcePath = resolved;
  return exp;
}

export async function loadRunnable(specPath: string): Promise<
  | { kind: "experiment"; exp: Experiment }
  | { kind: "suite"; suite: Suite }
  | { kind: "workflow"; workflow: Workflow }
> {
  const resolved = resolve(specPath);
  const { kind, raw } = await loadDocument(resolved);
  if (kind === "Suite") return { kind: "suite", suite: await loadSuiteFile(resolved) };
  if (kind === "Workflow") return { kind: "workflow", workflow: await loadWorkflowFile(resolved) };
  if (kind === "Workload" || kind === "ChaosProfile") {
    throw new Error(`${kind} cannot be run alone; write target.adapter + inject, or pair --workload / --profile`);
  }
  const expanded = await expandInjectRaw(raw, dirname(resolved));
  if (expanded.kind === "suite") {
    expanded.suite.sourcePath = resolved;
    return { kind: "suite", suite: expanded.suite };
  }
  return { kind: "experiment", exp: await loadExperimentFile(resolved) };
}

export async function loadSuiteFile(specPath: string): Promise<Suite> {
  const resolved = resolve(specPath);
  const { raw } = await loadDocument(resolved);
  return normalizeSuite(raw, resolved);
}

export async function loadWorkflowFile(specPath: string): Promise<Workflow> {
  const resolved = resolve(specPath);
  const { raw } = await loadDocument(resolved);
  return normalizeWorkflow(raw, resolved);
}

async function composeRefs(raw: any, fromDir: string): Promise<any> {
  const spec = raw?.spec && typeof raw.spec === "object" ? raw.spec : raw;
  const adapter = spec.target?.adapter ?? spec.agent;
  const workloadRef =
    (typeof spec.workload === "string" ? spec.workload : spec.workloadRef) ??
    implicitWorkload(adapter);
  const profileRef = typeof spec.profile === "string" ? spec.profile : spec.profileRef;
  let base: any = {};
  if (workloadRef) {
    const workload = await readKindFile(workloadRef, fromDir, "Workload");
    base = mergeDeep(base, stripKind(workload));
  }
  if (profileRef) {
    const profile = await readKindFile(profileRef, fromDir, "ChaosProfile");
    base = mergeDeep(base, stripKind(profile));
  }
  const overlay = { ...raw, spec: { ...spec } };
  if (typeof overlay.spec?.workload === "string") delete overlay.spec.workload;
  if (typeof overlay.spec?.profile === "string") delete overlay.spec.profile;
  return mergeDeep({ ...base, spec: { ...base.spec, ...overlay.spec }, metadata: overlay.metadata ?? base.metadata, kind: "Experiment", apiVersion: overlay.apiVersion ?? base.apiVersion }, overlay);
}

async function readKindFile(ref: string, fromDir: string, kind: string): Promise<any> {
  const path = resolveRef(ref, fromDir);
  const text = await readFile(path, "utf8");
  const raw = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  if (raw?.kind && raw.kind !== kind) throw new Error(`${path} kind is ${raw.kind}, expected ${kind}`);
  return raw;
}

function stripKind(raw: any): any {
  const spec = raw.spec ?? raw;
  return { apiVersion: raw.apiVersion, metadata: raw.metadata, spec };
}

function resolveRef(ref: string, fromDir: string): string {
  const candidates = [
    resolve(fromDir, ref),
    resolve(repoRoot(), ref),
    resolve(repoRoot(), "examples", ref),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`referenced file not found: ${ref}`);
  return found;
}

export type SuiteCase = {
  rel: string;
  specPath?: string;
  exp: Experiment;
};

export async function loadComposedExperiment(opts: {
  workload: string;
  profile?: string;
  fromDir?: string;
  name?: string;
  overlay?: Record<string, unknown>;
}): Promise<Experiment> {
  const fromDir = opts.fromDir ?? process.cwd();
  const workloadName = await fragmentName(opts.workload, fromDir);
  const profileName = opts.profile ? await fragmentName(opts.profile, fromDir) : undefined;
  const name = opts.name ?? (profileName ? `${workloadName}-${profileName}` : workloadName);
  const raw = {
    apiVersion: "agentchaos.dev/v1alpha1",
    kind: "Experiment",
    metadata: { name },
    spec: {
      ...(opts.overlay ?? {}),
      workload: opts.workload,
      profile: opts.profile,
    },
  };
  const merged = await composeRefs(raw, fromDir);
  merged.metadata = { ...merged.metadata, name };
  const exp = normalizeSpec(merged, { sourcePath: resolveRef(opts.workload, fromDir) });
  exp.sourcePath = resolveRef(opts.workload, fromDir);
  return exp;
}

export async function expandSuiteCases(suite: Suite): Promise<SuiteCase[]> {
  const baseDir = suite.sourcePath ? resolve(suite.sourcePath, "..") : process.cwd();
  const cases: SuiteCase[] = [];
  for (const rel of suite.experiments) {
    const specPath = resolve(baseDir, rel);
    cases.push({ rel, specPath, exp: await loadExperimentFile(specPath) });
  }
  let workloads = suite.workloads ?? [];
  let profiles = suite.profiles ?? [];
  if ((!workloads.length || !profiles.length) && suite.agent && suite.inject?.length) {
    const workload = implicitWorkload(suite.agent);
    if (workload) workloads = workloads.length ? workloads : [workload];
    profiles = profiles.length ? profiles : resolveInjectProfiles(suite.inject, baseDir);
  }
  for (const workload of workloads) {
    for (const profile of profiles) {
      const exp = await loadComposedExperiment({
        workload,
        profile,
        fromDir: baseDir,
        overlay: suite.overlay,
      });
      if (suite.agent) exp.agent = suite.agent;
      if (suite.inject) exp.inject = suite.inject;
      cases.push({ rel: `${workload} × ${profile}`, exp });
    }
  }
  return cases;
}

async function expandInjectRaw(
  raw: any,
  fromDir: string,
): Promise<{ kind: "experiment"; raw: any } | { kind: "suite"; suite: Suite }> {
  const spec = raw?.spec && typeof raw.spec === "object" ? raw.spec : raw;
  const parsed = parseInject(spec?.inject, spec?.together);
  if (!parsed?.tokens.length) return { kind: "experiment", raw };
  const adapter = spec.target?.adapter ?? spec.agent;
  const workload = (typeof spec.workload === "string" ? spec.workload : undefined) ?? implicitWorkload(adapter);
  const profiles = resolveInjectProfiles(parsed.tokens, fromDir);
  if (parsed.together || profiles.length <= 1) {
    const overlay = { ...raw, spec: { ...spec, workload, inject: parsed.tokens, together: parsed.together } };
    if (parsed.together && profiles.length > 1) {
      overlay.spec.faults = await mergeProfileFaults(profiles, fromDir);
    } else if (profiles[0]) {
      overlay.spec.profile = profiles[0];
    }
    return { kind: "experiment", raw: overlay };
  }
  if (!workload) throw new Error("inject needs target.adapter (zcode / codex / claude / kimi) or spec.workload");
  const agent = String(adapter ?? "agent");
  const name = raw.metadata?.name ?? comboLabel(agent, parsed.tokens) ?? "inject";
  return {
    kind: "suite",
    suite: {
      apiVersion: raw.apiVersion ?? "agentchaos.dev/v1alpha1",
      kind: "Suite",
      name,
      repeat: 1,
      experiments: [],
      workloads: [workload],
      profiles,
      agent,
      inject: parsed.tokens,
      overlay: Object.fromEntries(
        Object.entries({
          target: spec.target,
          fixture: spec.fixture,
          timeout: spec.timeout,
          git: spec.git,
          assertions: spec.assertions,
          recovery: spec.recovery,
          mode: spec.mode,
          budget: spec.budget,
        }).filter(([, value]) => value !== undefined),
      ),
      sourcePath: raw.sourcePath,
    },
  };
}

async function mergeProfileFaults(profiles: string[], fromDir: string): Promise<unknown[]> {
  const faults: unknown[] = [];
  for (const profile of profiles) {
    const raw = await readKindFile(profile, fromDir, "ChaosProfile");
    const list = raw.spec?.faults ?? raw.faults ?? [];
    if (Array.isArray(list)) faults.push(...list);
  }
  return faults;
}

async function fragmentName(ref: string, fromDir: string): Promise<string> {
  const path = resolveRef(ref, fromDir);
  const text = await readFile(path, "utf8");
  const raw = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return raw?.metadata?.name ?? basename(path, extname(path));
}

function mergeDeep(a: any, b: any): any {
  if (Array.isArray(b)) return b.slice();
  if (b && typeof b === "object" && a && typeof a === "object" && !Array.isArray(a)) {
    const out: any = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = k in a ? mergeDeep(a[k], v) : v;
    }
    return out;
  }
  return b === undefined ? a : b;
}
