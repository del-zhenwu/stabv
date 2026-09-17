import { mkdir, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Experiment, Suite } from "./spec.ts";
import { expandSuiteCases } from "./compose.ts";
import { runExperiment, type RunResult } from "./runner.ts";
import { validateExperiment } from "./spec.ts";
import { writeSuiteReport } from "./report.ts";
import { HelperClient } from "./helper.ts";
import { previewRisk } from "./capabilities.ts";

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
  status?: "running" | "done";
  agent?: string;
  inject?: string[];
};

export async function runSuite(suite: Suite, opts: { repeat?: number } = {}): Promise<SuiteReport> {
  const repeat = Math.max(1, opts.repeat ?? suite.repeat ?? 1);
  const helperCaps = ((await HelperClient.discover().caps()) as { capabilities?: string[] }).capabilities ?? [];
  // Load and validate every experiment up front so a bad spec fails before any trial runs.
  const loaded = await expandSuiteCases(suite);
  const names = new Map<string, string[]>();
  for (const item of loaded) {
    const errors = validateExperiment(item.exp);
    if (errors.length) throw new Error(`${item.rel}: ${errors.join("; ")}`);
    const risk = previewRisk(item.exp, helperCaps);
    if (risk.status === "unsupported") throw new Error(`${item.rel}: unsupported capability: ${risk.notes.join("; ")}`);
    names.set(item.exp.name, [...(names.get(item.exp.name) ?? []), item.rel]);
  }
  // Two experiments sharing a name would silently merge their pass^k stats; fail loudly instead.
  for (const [name, paths] of names) {
    const unique = [...new Set(paths)];
    if (unique.length > 1) throw new Error(`suite experiments share metadata.name "${name}": ${unique.join(", ")}`);
  }
  const report: SuiteReport = {
    id: randomUUID(),
    name: suite.name,
    repeat,
    trials: [],
    passK: {},
    passed: false,
    status: "running",
    agent: suite.agent,
    inject: suite.inject,
  };
  const outDir = resolve(process.cwd(), ".agentchaos-runs", `suite-${report.id}`);
  await mkdir(outDir, { recursive: true });
  await writeSuiteReport(outDir, report);
  for (const { specPath, exp, rel } of loaded) {
    for (let i = 1; i <= repeat; i++) {
      const result = await runOnce(exp, specPath);
      report.trials.push({
        experiment: specPath ?? rel,
        name: exp.name,
        trial: i,
        runId: result.report.id,
        passed: result.report.passed,
      });
      report.passK = buildPassK(report.trials);
      await writeSuiteReport(outDir, report);
    }
  }
  report.passK = buildPassK(report.trials);
  report.passed = Object.values(report.passK).every((x) => x.passHatK);
  report.status = "done";
  await writeSuiteReport(outDir, report);
  await appendFile(
    join(outDir, "..", "index.jsonl"),
    JSON.stringify({ id: report.id, name: report.name, kind: "suite", passed: report.passed, ts: Date.now(), report: join(outDir, "suite.json") }) + "\n",
  );
  console.log(JSON.stringify({ suite_id: report.id, passed: report.passed, passK: report.passK, report: join(outDir, "suite.json"), html: join(outDir, "report.html") }, null, 2));
  return report;
}

function buildPassK(trials: Trial[]): SuiteReport["passK"] {
  const passK: SuiteReport["passK"] = {};
  for (const trial of trials) {
    const key = trial.name;
    passK[key] ??= { passed: 0, total: 0, passHatK: true };
    passK[key].total += 1;
    if (trial.passed) passK[key].passed += 1;
    else passK[key].passHatK = false;
  }
  return passK;
}

async function runOnce(exp: Experiment, specPath?: string): Promise<RunResult> {
  return runExperiment(exp, specPath);
}
