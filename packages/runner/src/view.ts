import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { repoRoot } from "./paths.ts";
import { renderIndexHtml, type IndexRun } from "./report.ts";

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
};

export function runsRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const cwd = resolve(process.cwd(), ".agentchaos-runs");
  if (existsSync(cwd)) return cwd;
  return resolve(repoRoot(), ".agentchaos-runs");
}

export function collectRuns(dir: string): IndexRun[] {
  if (!existsSync(dir)) return [];
  const out: IndexRun[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    const html = join(full, "report.html");
    const json = join(full, "report.json");
    const suite = join(full, "suite.json");
    const workflow = join(full, "workflow.json");
    if (existsSync(json)) {
      const report = readJson(json);
      out.push({
        id: report.id ?? name,
        name: report.name ?? name,
        kind: "experiment",
        passed: Boolean(report.passed),
        href: existsSync(html) ? `/runs/${name}/report.html` : `/runs/${name}/report.json`,
        durationMs: report.metrics?.durationMs ?? (report.finishedAt && report.startedAt ? report.finishedAt - report.startedAt : undefined),
        mtime: statSync(full).mtimeMs,
      });
    } else if (existsSync(suite)) {
      const report = readJson(suite);
      out.push({
        id: report.id ?? name,
        name: report.name ?? name,
        kind: "suite",
        passed: Boolean(report.passed),
        href: existsSync(html) ? `/runs/${name}/report.html` : `/runs/${name}/suite.json`,
        mtime: statSync(full).mtimeMs,
      });
    } else if (existsSync(workflow)) {
      const report = readJson(workflow);
      out.push({
        id: report.id ?? name,
        name: report.name ?? name,
        kind: "workflow",
        passed: Boolean(report.passed),
        href: existsSync(html) ? `/runs/${name}/report.html` : `/runs/${name}/workflow.json`,
        mtime: statSync(full).mtimeMs,
      });
    }
  }
  return out.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
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
    const runMatch = url.pathname.match(/^\/runs\/([^/]+)\/?(.+)?$/);
    if (runMatch) {
      const id = decodeURIComponent(runMatch[1]);
      const file = runMatch[2] || "report.html";
      const root = resolve(dir);
      const path = resolve(root, id, file);
      const rel = relative(root, path);
      const inside = rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !path.startsWith(`..${sep}`);
      if (!inside || !existsSync(path) || statSync(path).isDirectory()) {
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

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
