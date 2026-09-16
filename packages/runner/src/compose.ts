import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { existsSync } from "node:fs";
import { repoRoot } from "./paths.ts";
import { normalizeSpec, normalizeSuite, normalizeWorkflow, type Experiment, type Suite, type Workflow } from "./spec.ts";
import { faultLineNumbers } from "./yaml-loc.ts";

export async function loadDocument(specPath: string): Promise<{ kind: string; raw: any; text: string }> {
  const text = await readFile(specPath, "utf8");
  const raw = specPath.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return { kind: raw?.kind ?? "Experiment", raw, text };
}

export async function loadExperimentFile(specPath: string): Promise<Experiment> {
  const resolved = resolve(specPath);
  const { raw, text } = await loadDocument(resolved);
  if (raw?.kind === "Suite") throw new Error(`${specPath} is a Suite; use: agentchaos suite ${specPath}`);
  const merged = await composeRefs(raw, dirname(resolved));
  const exp = normalizeSpec(merged, {
    sourcePath: resolved,
    faultLines: resolved.endsWith(".json") ? [] : faultLineNumbers(text),
  });
  exp.sourcePath = resolved;
  return exp;
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
  const workloadRef = typeof spec.workload === "string" ? spec.workload : spec.workloadRef;
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
