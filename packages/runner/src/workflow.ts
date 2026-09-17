import { mkdir, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Experiment, Workflow } from "./spec.ts";
import { loadExperimentFile } from "./compose.ts";
import { runExperiment, type RunResult } from "./runner.ts";
import { validateExperiment } from "./spec.ts";
import { writeWorkflowReport } from "./report.ts";
import { HelperClient } from "./helper.ts";
import { previewRisk } from "./capabilities.ts";

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
  status?: "running" | "done";
};

type Prepared = {
  taskIndex: number;
  mode: "serial" | "parallel";
  specPath: string;
  exp: Experiment;
};

export async function runWorkflow(workflow: Workflow, opts: { failFast?: boolean } = {}): Promise<WorkflowReport> {
  const baseDir = workflow.sourcePath ? resolve(workflow.sourcePath, "..") : process.cwd();
  const helperCaps = ((await HelperClient.discover().caps()) as { capabilities?: string[] }).capabilities ?? [];
  const failFast = opts.failFast ?? workflow.failFast;
  const prepared: Prepared[] = [];
  for (const [taskIndex, task] of workflow.tasks.entries()) {
    for (const rel of task.experiments) {
      const specPath = resolve(baseDir, rel);
      const exp = await loadExperimentFile(specPath);
      const errors = validateExperiment(exp);
      if (errors.length) throw new Error(`${rel}: ${errors.join("; ")}`);
      const risk = previewRisk(exp, helperCaps);
      if (risk.status === "unsupported") throw new Error(`${rel}: unsupported capability: ${risk.notes.join("; ")}`);
      prepared.push({ taskIndex, mode: task.type, specPath, exp });
    }
  }
  const report: WorkflowReport = {
    id: randomUUID(),
    name: workflow.name,
    steps: [],
    passed: false,
    status: "running",
  };
  const outDir = resolve(process.cwd(), ".agentchaos-runs", `workflow-${report.id}`);
  await mkdir(outDir, { recursive: true });
  await writeWorkflowReport(outDir, report);

  const runPrepared = async (item: Prepared): Promise<WorkflowStep> => {
    const result: RunResult = await runExperiment(item.exp, item.specPath);
    return {
      task: item.taskIndex,
      mode: item.mode,
      experiment: item.specPath,
      name: item.exp.name,
      runId: result.report.id,
      passed: result.report.passed,
    };
  };

  for (const [taskIndex, task] of workflow.tasks.entries()) {
    const items = prepared.filter((item) => item.taskIndex === taskIndex);
    if (task.type === "parallel") {
      const batch = await Promise.all(items.map(runPrepared));
      report.steps.push(...batch);
      await writeWorkflowReport(outDir, report);
      if (failFast && batch.some((step) => !step.passed)) break;
    } else {
      let failed = false;
      for (const item of items) {
        const step = await runPrepared(item);
        report.steps.push(step);
        await writeWorkflowReport(outDir, report);
        if (!step.passed) {
          failed = true;
          if (failFast) break;
        }
      }
      if (failFast && failed) break;
    }
  }
  report.passed = report.steps.length > 0 && report.steps.every((step) => step.passed);
  report.status = "done";
  await writeWorkflowReport(outDir, report);
  await appendFile(
    join(outDir, "..", "index.jsonl"),
    JSON.stringify({ id: report.id, name: report.name, kind: "workflow", passed: report.passed, ts: Date.now(), report: join(outDir, "workflow.json") }) + "\n",
  );
  console.log(
    JSON.stringify(
      { workflow_id: report.id, passed: report.passed, steps: report.steps, report: join(outDir, "workflow.json"), html: join(outDir, "report.html") },
      null,
      2,
    ),
  );
  return report;
}
