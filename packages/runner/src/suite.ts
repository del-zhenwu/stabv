import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Experiment, Suite } from "./spec.ts";
import { loadExperimentFile } from "./compose.ts";
import { runExperiment, type RunResult } from "./runner.ts";
import { validateExperiment } from "./spec.ts";
import { writeSuiteReport } from "./report.ts";

export type Trial = {
  experiment: string;
  name: string;
  trial: number;
  runId: string;
  passed: boolean;
};

export type SuiteReport = {
  id: string;
  name: string;
  repeat: number;
  trials: Trial[];
  passK: Record<string, { passed: number; total: number; passHatK: boolean }>;
  passed: boolean;
};

export async function runSuite(suite: Suite, opts: { repeat?: number } = {}): Promise<SuiteReport> {
  const repeat = Math.max(1, opts.repeat ?? suite.repeat ?? 1);
  const baseDir = suite.sourcePath ? resolve(suite.sourcePath, "..") : process.cwd();
  // Load and validate every experiment up front so a bad spec fails before any trial runs.
  const loaded: { rel: string; specPath: string; exp: Experiment }[] = [];
  for (const rel of suite.experiments) {
    const specPath = resolve(baseDir, rel);
    const exp = await loadExperimentFile(specPath);
    const errors = validateExperiment(exp);
    if (errors.length) throw new Error(`${rel}: ${errors.join("; ")}`);
    loaded.push({ rel, specPath, exp });
  }
  const trials: Trial[] = [];
  for (const { rel, specPath, exp } of loaded) {
    for (let i = 1; i <= repeat; i++) {
      const result = await runOnce(exp, specPath);
      trials.push({
        experiment: specPath,
        name: exp.name,
        trial: i,
        runId: result.report.id,
        passed: result.report.passed,
      });
    }
  }
  const passK: SuiteReport["passK"] = {};
  const keyOf = new Map<string, string[]>();
  for (const trial of trials) {
    const key = trial.name;
    passK[key] ??= { passed: 0, total: 0, passHatK: true };
    keyOf.set(key, [...(keyOf.get(key) ?? []), trial.experiment]);
    passK[key].total += 1;
    if (trial.passed) passK[key].passed += 1;
    else passK[key].passHatK = false;
  }
  // Two experiments sharing a name would silently merge their pass^k stats; fail loudly instead.
  for (const [name, paths] of keyOf) {
    const unique = [...new Set(paths)];
    if (unique.length > 1) throw new Error(`suite experiments share metadata.name "${name}": ${unique.join(", ")}`);
  }
  const report: SuiteReport = {
    id: randomUUID(),
    name: suite.name,
    repeat,
    trials,
    passK,
    passed: Object.values(passK).every((x) => x.passHatK),
  };
  const outDir = resolve(process.cwd(), ".agentchaos-runs", `suite-${report.id}`);
  await mkdir(outDir, { recursive: true });
  await writeSuiteReport(outDir, report);
  console.log(JSON.stringify({ suite_id: report.id, passed: report.passed, passK: report.passK, report: join(outDir, "suite.json"), html: join(outDir, "report.html") }, null, 2));
  return report;
}

async function runOnce(exp: Experiment, specPath: string): Promise<RunResult> {
  return runExperiment(exp, specPath);
}
