import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { repoRoot } from "./paths.ts";
import { classifyRun, renderHtml, renderIndexHtml, renderSuiteHtml, type IndexRun } from "./report.ts";
import type { ChaosEvent } from "./events.ts";

export type ViewOptions = {
  host?: string;
  port?: number;
  open?: boolean;
  runsDir?: string;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".jsonl": "application/jsonl; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function runsRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const cwd = resolve(process.cwd(), ".agentchaos-runs");
  if (existsSync(cwd)) return cwd;
  return resolve(repoRoot(), ".agentchaos-runs");
}

type ScannedRun = IndexRun & {
  dirName: string;
  childIds: string[];
  startedAt?: number;
  finishedAt?: number;
};

export const ZCODE_CASES = [
  "zcode-file-edit",
  "zcode-process-kill",
  "zcode-rate-limit",
  "zcode-llm-500",
  "zcode-stream-truncate",
  "zcode-autonomous-nemesis",
  "zcode-auto",
];

const PRODUCT_FAMILIES = [{ name: "zcode", cases: ZCODE_CASES }];

export function collectRuns(dir: string): IndexRun[] {
  const scanned = scanRunDirs(dir);
  const byKey = new Map<string, ScannedRun>();
  for (const run of scanned) {
    byKey.set(run.id, run);
    byKey.set(run.dirName, run);
  }
  const owned = new Set<string>();
  for (const run of scanned) {
    for (const childId of run.childIds) owned.add(childId);
  }
  const familyCaseNames = new Set(PRODUCT_FAMILIES.flatMap((family) => family.cases));
  const jobs: IndexRun[] = [];
  for (const run of scanned) {
    if (run.kind === "experiment" && (owned.has(run.id) || owned.has(run.dirName) || familyCaseNames.has(run.name))) continue;
    const childScanned = run.childIds.map((id) => byKey.get(id)).filter((child): child is ScannedRun => Boolean(child));
    const children = childScanned.map((child) => publicRun(child));
    const starts = childScanned.map((child) => child.startedAt).filter((n): n is number => n != null);
    const ends = childScanned.map((child) => child.finishedAt).filter((n): n is number => n != null);
    const durationMs =
      starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : run.durationMs;
    const isTask = run.kind === "suite" || run.kind === "workflow";
    jobs.push(
      publicRun(run, {
        durationMs,
        children: children.length ? children : undefined,
        cases: isTask ? (run.childIds.length || children.length) : undefined,
        passedCases: isTask ? children.filter((child) => child.passed).length : undefined,
      }),
    );
  }
  jobs.push(...productFamilyJobs(scanned));
  return jobs.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
}

export function renderProductFamilyHtml(dir: string, familyName: string): string | undefined {
  const family = PRODUCT_FAMILIES.find((item) => item.name === familyName);
  if (!family) return undefined;
  const members = scanRunDirs(dir)
    .filter((run) => run.kind === "experiment" && family.cases.includes(run.name))
    .sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0));
  if (!members.length) return undefined;
  const seen = new Map<string, number>();
  const trials = members.map((run) => {
    const trial = (seen.get(run.name) ?? 0) + 1;
    seen.set(run.name, trial);
    return { experiment: run.name, name: run.name, trial, runId: run.dirName, passed: run.passed, verdict: run.verdict };
  });
  const passK: Record<string, { passed: number; total: number; passHatK: boolean }> = {};
  for (const trial of trials) {
    passK[trial.name] ??= { passed: 0, total: 0, passHatK: true };
    passK[trial.name].total += 1;
    if (trial.passed) passK[trial.name].passed += 1;
    else if (trial.verdict !== "inconclusive") passK[trial.name].passHatK = false;
  }
  for (const row of Object.values(passK)) {
    if (row.passed === 0) row.passHatK = false;
  }
  return renderSuiteHtml(
    {
      id: family.name,
      name: family.name,
      repeat: 1,
      trials,
      passK,
      passed: Object.values(passK).every((row) => row.passHatK),
      status: "done",
    },
    { caseHref: (runId) => `/runs/${runId}/report.html` },
  );
}

function productFamilyJobs(scanned: ScannedRun[]): IndexRun[] {
  const out: IndexRun[] = [];
  for (const family of PRODUCT_FAMILIES) {
    const members = scanned.filter((run) => run.kind === "experiment" && family.cases.includes(run.name));
    if (!members.length) continue;
    const latestByName = new Map<string, ScannedRun>();
    for (const run of members) {
      const prev = latestByName.get(run.name);
      if (!prev || (run.mtime ?? 0) > (prev.mtime ?? 0)) latestByName.set(run.name, run);
    }
    const latest = family.cases.map((name) => latestByName.get(name)).filter((run): run is ScannedRun => Boolean(run));
    const starts = latest.map((run) => run.startedAt).filter((n): n is number => n != null);
    const ends = latest.map((run) => run.finishedAt).filter((n): n is number => n != null);
    out.push({
      id: `family-${family.name}`,
      name: family.name,
      kind: "suite",
      passed: latest.length > 0 && latest.every((run) => run.passed),
      href: `/tasks/${family.name}`,
      durationMs: starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : undefined,
      mtime: Math.max(...members.map((run) => run.mtime ?? 0)),
      cases: latest.length,
      passedCases: latest.filter((run) => run.passed).length,
      children: latest.map((run) => publicRun(run)),
    });
  }
  return out;
}

function scanRunDirs(dir: string): ScannedRun[] {
  if (!existsSync(dir)) return [];
  const out: ScannedRun[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    const html = join(full, "report.html");
    const json = join(full, "report.json");
    const suite = join(full, "suite.json");
    const workflow = join(full, "workflow.json");
    const mtime = statSync(full).mtimeMs;
    if (existsSync(json)) {
      const report = readJson(json);
      const startedAt = typeof report.startedAt === "number" ? report.startedAt : undefined;
      const finishedAt = typeof report.finishedAt === "number" ? report.finishedAt : undefined;
      const classified = classifyRun(report, []);
      out.push({
        id: report.id ?? name,
        name: report.name ?? name,
        kind: "experiment",
        passed: classified.verdict === "pass",
        verdict: classified.verdict,
        href: existsSync(html) ? `/runs/${name}/report.html` : `/runs/${name}/report.json`,
        durationMs: report.metrics?.durationMs ?? (finishedAt != null && startedAt != null ? finishedAt - startedAt : undefined),
        mtime,
        dirName: name,
        childIds: [],
        startedAt,
        finishedAt,
      });
    } else if (existsSync(suite)) {
      const report = readJson(suite);
      const childIds = Array.isArray(report.trials)
        ? report.trials.map((t: { runId?: string }) => t.runId).filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      out.push({
        id: report.id ?? name,
        name: report.name ?? name,
        kind: "suite",
        passed: Boolean(report.passed),
        href: existsSync(html) ? `/runs/${name}/report.html` : `/runs/${name}/suite.json`,
        mtime,
        dirName: name,
        childIds,
        status: report.status === "running" ? "running" : "done",
      });
    } else if (existsSync(workflow)) {
      const report = readJson(workflow);
      const childIds = Array.isArray(report.steps)
        ? report.steps.map((s: { runId?: string }) => s.runId).filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      out.push({
        id: report.id ?? name,
        name: report.name ?? name,
        kind: "workflow",
        passed: Boolean(report.passed),
        href: existsSync(html) ? `/runs/${name}/report.html` : `/runs/${name}/workflow.json`,
        mtime,
        dirName: name,
        childIds,
        status: report.status === "running" ? "running" : "done",
      });
    }
  }
  return out;
}

function publicRun(run: ScannedRun, extra: Partial<IndexRun> = {}): IndexRun {
  return {
    id: run.id,
    name: run.name,
    kind: run.kind,
    passed: run.passed,
    href: run.href,
    durationMs: run.durationMs,
    mtime: run.mtime,
    status: run.status,
    ...extra,
  };
}

export async function startViewer(opts: ViewOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const dir = runsRoot(opts.runsDir);
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8080;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = renderIndexHtml(collectRuns(dir));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (url.pathname === "/api/runs") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(collectRuns(dir)));
      return;
    }
    if (url.pathname === "/api/runs/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      let previous = "";
      const push = () => {
        const payload = JSON.stringify(collectRuns(dir));
        if (payload === previous) return;
        previous = payload;
        res.write(`event: runs\ndata: ${payload}\n\n`);
      };
      push();
      const timer = setInterval(push, 1000);
      req.on("close", () => clearInterval(timer));
      return;
    }
    const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)\/?$/);
    if (taskMatch) {
      const html = renderProductFamilyHtml(dir, decodeURIComponent(taskMatch[1]));
      if (!html) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    const runMatch = url.pathname.match(/^\/runs\/([^/]+)\/?(.+)?$/);
    if (runMatch) {
      const id = decodeURIComponent(runMatch[1]);
      const file = runMatch[2] || "report.html";
      const root = resolve(dir);
      const path = resolve(root, id, file);
      const rel = relative(root, path);
      const inside = rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !path.startsWith(`..${sep}`);
      if (!inside) {
        res.writeHead(404).end("not found");
        return;
      }
      if (file === "report.html") {
        try {
          const live = renderStoredReport(root, id);
          if (live) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(live);
            return;
          }
        } catch {
          /* fall back to the static file */
        }
      }
      if (!existsSync(path) || statSync(path).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
      }
      const type = MIME[extname(path)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type });
      res.end(readFileSync(path));
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen());
  });
  const url = `http://${host}:${(server.address() as { port: number }).port}`;
  return {
    url,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

export function openBrowser(url: string): void {
  if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function renderStoredReport(root: string, id: string): string | undefined {
  const jsonPath = join(root, id, "report.json");
  if (!existsSync(jsonPath)) return undefined;
  const report = readJson(jsonPath);
  if (!report.id && !report.name) return undefined;
  const eventsPath = join(root, id, "events.jsonl");
  const events: ChaosEvent[] = [];
  if (existsSync(eventsPath)) {
    for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as ChaosEvent);
      } catch {
        /* skip a corrupt event line */
      }
    }
  }
  return renderHtml(report, events);
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
