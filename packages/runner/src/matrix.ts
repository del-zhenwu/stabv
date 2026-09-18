import { readFile } from "node:fs/promises";
import type { Report } from "./report.ts";

export type MatrixRow = {
  id: string;
  name: string;
  dimension: string;
  verdict: string;
  passed: boolean;
  durationMs?: number;
  recoveryRate?: number;
};

export type MatrixComparison = {
  rows: MatrixRow[];
  dimensions: Record<string, { total: number; passed: number; passRate: number }>;
};

export function compareReports(reports: Report[]): MatrixComparison {
  const rows = reports.map((report) => {
    const dimension = report.inject?.join("+") || report.injected?.join("+") || report.name;
    return {
      id: report.id,
      name: report.name,
      dimension,
      verdict: report.verdict ?? (report.passed ? "pass" : "fail"),
      passed: report.passed,
      durationMs: report.metrics?.durationMs,
      recoveryRate: report.metrics?.recoveryRate,
    };
  });
  const dimensions: MatrixComparison["dimensions"] = {};
  for (const row of rows) {
    const item = dimensions[row.dimension] ?? { total: 0, passed: 0, passRate: 0 };
    item.total += 1;
    if (row.passed) item.passed += 1;
    item.passRate = item.passed / item.total;
    dimensions[row.dimension] = item;
  }
  return { rows, dimensions };
}

export async function loadReports(paths: string[]): Promise<Report[]> {
  return Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as Report));
}

export function renderMatrixMarkdown(matrix: MatrixComparison): string {
  const lines = ["| dimension | runs | passed | pass rate |", "|---|---:|---:|---:|"];
  for (const [dimension, row] of Object.entries(matrix.dimensions)) {
    lines.push(`| ${dimension} | ${row.total} | ${row.passed} | ${(row.passRate * 100).toFixed(1)}% |`);
  }
  return lines.join("\n") + "\n";
}
