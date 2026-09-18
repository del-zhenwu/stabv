import type { Experiment } from "./spec.ts";
import { runExperiment, type RunResult } from "./runner.ts";

export type EnduranceReport = {
  iterations: number;
  passed: number;
  passRate: number;
  failures: { iteration: number; runId: string; error?: string }[];
  runs: string[];
};

export async function runEndurance(exp: Experiment, iterations = 10, specPath?: string): Promise<EnduranceReport> {
  const failures: EnduranceReport["failures"] = [];
  const runs: string[] = [];
  for (let iteration = 1; iteration <= Math.max(1, iterations); iteration += 1) {
    let result: RunResult;
    try {
      result = await runExperiment(exp, specPath);
      runs.push(result.report.id);
      if (!result.report.passed) failures.push({ iteration, runId: result.report.id });
    } catch (error) {
      failures.push({ iteration, runId: "", error: error instanceof Error ? error.message : String(error) });
    }
  }
  const total = Math.max(1, iterations);
  return { iterations: total, passed: total - failures.length, passRate: (total - failures.length) / total, failures, runs };
}
