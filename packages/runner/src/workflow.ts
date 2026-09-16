import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Workflow } from "./spec.ts";
import { loadExperimentFile } from "./compose.ts";
import { runExperiment, type RunResult } from "./runner.ts";
import { validateExperiment } from "./spec.ts";
import { writeWorkflowReport } from "./report.ts";

export type WorkflowStep = {
  task: number;
  mode: "serial" | "parallel";
  experiment: string;
  name: string;
  runId: string;
  passed: boolean;
};

export type WorkflowReport = {
  id: string;
  name: string;
  steps: WorkflowStep[];
  passed: boolean;
};

export async function runWorkflow(workflow: Workflow, opts: { failFast?: boolean } = {}): Promise<WorkflowReport> {
  const baseDir = workflow.sourcePath ? resolve(workflow.sourcePath, "..") : process.cwd();
  const failFast = opts.failFast ?? workflow.failFast;
  const steps: WorkflowStep[] = [];
  for (const [taskIndex, task] of workflow.tasks.entries()) {
    const runOne = async (rel: string): Promise<WorkflowStep> => {
      const specPath = resolve(baseDir, rel);
      const exp = await loadExperimentFile(specPath);
      const errors = validateExperiment(exp);
      if (errors.length) throw new Error(`${rel}: ${errors.join("; ")}`);
      const result: RunResult = await runExperiment(exp, specPath);
      return {
        task: taskIndex,
        mode: task.type,
        experiment: specPath,
        name: exp.name,
        runId: result.report.id,
        passed: result.report.passed,
      };
    };
    if (task.type === "parallel") {
      const batch = await Promise.all(task.experiments.map(runOne));
      steps.push(...batch);
      if (failFast && batch.some((step) => !step.passed)) break;
    } else {
      let failed = false;
      for (const rel of task.experiments) {
        const step = await runOne(rel);
        steps.push(step);
        if (!step.passed) {
          failed = true;
          if (failFast) break;
        }
      }
      if (failFast && failed) break;
    }
  }
  const report: WorkflowReport = {
    id: randomUUID(),
    name: workflow.name,
    steps,
    passed: steps.length > 0 && steps.every((step) => step.passed),
  };
  const outDir = resolve(process.cwd(), ".agentchaos-runs", `workflow-${report.id}`);
  await mkdir(outDir, { recursive: true });
  await writeWorkflowReport(outDir, report);
  console.log(
    JSON.stringify(
      { workflow_id: report.id, passed: report.passed, steps: report.steps, report: join(outDir, "workflow.json"), html: join(outDir, "report.html") },
      null,
      2,
    ),
  );
  return report;
}
