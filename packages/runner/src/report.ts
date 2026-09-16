import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult } from "./assertions.ts";
import type { ChaosEvent } from "./events.ts";
import type { RiskPreview } from "./capabilities.ts";

export type Metrics = {
  durationMs: number;
  mttrMs?: number;
  injected: number;
  recovered: number;
  recoveryRate: number;
  toolCalls: number;
  duplicateToolIds: string[];
  duplicateSideEffectRate: number;
  stateDivergence?: boolean;
  orphanCount: number;
  resumeAttempts: number;
  restarts: number;
  resumeSuccess?: boolean;
  reworkRatio?: number;
  userInterventionCount: number;
  shadowSnapshots: number;
};

export type MetricContext = {
  start?: string;
  end?: string;
  tree?: { root: number; alive: boolean; processes: { pid: number }[] };
  cancelled?: boolean;
  /** A resumed agent re-emitted the same session id (session continuity verified). */
  resumeVerified?: boolean;
  /** A resumed agent re-emitted a DIFFERENT session id — state divergence signal. */
  resumeMismatched?: string;
};

export type Report = {
  id: string;
  name: string;
  startedAt: number;
  finishedAt: number;
  command: string[];
  workspace: string;
  result: { code: number | null; signal: string | null; timedOut: boolean; cancelled?: boolean };
  injected: string[];
  checks: CheckResult[];
  passed: boolean;
  events: string;
  metrics?: Metrics;
  risk?: RiskPreview;
  env?: Record<string, string>;
  workspaceHash?: { start?: string; end?: string };
};

export async function writeReport(runRoot: string, report: Report, events: ChaosEvent[]): Promise<void> {
  await writeFile(join(runRoot, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(runRoot, "report.html"), renderHtml(report, events));
  await writeFile(join(runRoot, "report.md"), renderMarkdown(report, events));
}

export async function writeSuiteReport(
  outDir: string,
  report: {
    id: string;
    name: string;
    repeat: number;
    trials: { experiment: string; name: string; trial: number; runId: string; passed: boolean }[];
    passK: Record<string, { passed: number; total: number; passHatK: boolean }>;
    passed: boolean;
  },
): Promise<void> {
  await writeFile(join(outDir, "suite.json"), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, "report.html"), renderSuiteHtml(report));
}

export async function writeWorkflowReport(
  outDir: string,
  report: {
    id: string;
    name: string;
    steps: { task: number; mode: string; experiment: string; name: string; runId: string; passed: boolean }[];
    passed: boolean;
  },
): Promise<void> {
  await writeFile(join(outDir, "workflow.json"), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, "report.html"), renderWorkflowHtml(report));
}

export function computeMetrics(
  events: ChaosEvent[],
  startedAt: number,
  finishedAt: number,
  duplicateToolIds: string[],
  toolCalls: number,
  ctx: MetricContext = {},
): Metrics {
  const mttrPairs: number[] = [];
  let openInjection: number | null = null;
  for (const e of events) {
    if (e.event === "fault_injected") {
      if (openInjection == null) openInjection = e.ts;
    } else if (e.event === "fault_recovered") {
      if (openInjection != null) {
        mttrPairs.push(Math.max(0, e.ts - openInjection));
        openInjection = null;
      }
    }
  }
  const mttrMs = mttrPairs.length ? Math.round(mttrPairs.reduce((a, b) => a + b, 0) / mttrPairs.length) : undefined;
  const injected = events.filter((e) => e.event === "fault_injected").length;
  const recovered = events.filter((e) => e.event === "fault_recovered").length;
  const recoveryActions = events
    .filter((e) => e.event === "recovery_started")
    .map((e) => String((e.detail as { action?: string } | undefined)?.action ?? ""));
  const resumeAttempts = recoveryActions.filter((a) => a === "resume").length;
  const restarts = recoveryActions.filter((a) => a === "restart").length;
  const lastResume = [...events].reverse().find((e) => e.event === "recovery_started");
  const durationMs = finishedAt - startedAt;
  const reworkRatio =
    lastResume != null && durationMs > 0 ? Math.max(0, Math.min(1, (finishedAt - lastResume.ts) / durationMs)) : undefined;
  const lockAfterRecover = events.some((e) => {
    if (e.event !== "shadow_compare") return false;
    const detail = e.detail as { git?: { indexLock?: boolean }; phase?: string } | undefined;
    return detail?.phase === "end" && detail.git?.indexLock === true;
  });
  const processAliveAfterKill = events.some((e) => {
    if (e.event !== "shadow_compare") return false;
    const detail = e.detail as { phase?: string; process?: { alive?: boolean } } | undefined;
    return Boolean(detail?.phase?.includes("process.kill")) && detail?.process?.alive === true;
  });
  const orphanCount = (ctx.tree?.processes ?? []).filter((p) => p.pid !== ctx.tree?.root).length;
  const resumeSuccess =
    resumeAttempts === 0 ? undefined : ctx.resumeVerified ? true : ctx.resumeMismatched != null ? false : undefined;
  return {
    durationMs,
    mttrMs,
    injected,
    recovered,
    recoveryRate: injected === 0 ? 1 : recovered / injected,
    toolCalls,
    duplicateToolIds,
    duplicateSideEffectRate: toolCalls === 0 ? 0 : duplicateToolIds.length / toolCalls,
    stateDivergence: lockAfterRecover || processAliveAfterKill,
    orphanCount,
    resumeAttempts,
    restarts,
    resumeSuccess,
    reworkRatio,
    userInterventionCount: ctx.cancelled ? 1 : 0,
    shadowSnapshots: events.filter((e) => e.event === "shadow_compare").length,
  };
}

export function renderHtml(report: Report, events: ChaosEvent[]): string {
  const passed = report.checks.filter((c) => c.passed).length;
  const scores = report.checks
    .map(
      (c) => `<tr>
        <td class="mono">${escape(c.assertion)}</td>
        <td><span class="pill ${c.passed ? "ok" : "fail"}">${c.passed ? "pass" : "fail"}</span></td>
        <td class="muted">${escape(c.detail ?? "")}</td>
      </tr>`,
    )
    .join("");
  const TRACE_CAP = 250;
  const truncated = events.length > TRACE_CAP;
  const shown = truncated ? events.slice(-TRACE_CAP) : events;
  const origin = events[0]?.ts ?? report.startedAt;
  const trace = shown
    .map((e) => {
      const kind = eventKind(e.event);
      return `<button class="step" data-kind="${kind}" type="button">
        <span class="dot ${kind}"></span>
        <span class="t">${fmtRel(e.ts - origin)}</span>
        <span class="ev">${escape(e.event)}</span>
        ${e.state ? `<span class="state">${escape(e.state)}</span>` : ""}
        <pre class="detail">${escape(fmtDetail(e.detail))}</pre>
      </button>`;
    })
    .join("");
  const faults = (report.injected ?? []).map((f) => `<span class="tag">${escape(f)}</span>`).join("") || `<span class="muted">none</span>`;
  const metrics = report.metrics;
  const cards = [
    metric("duration", fmtMs(metrics?.durationMs ?? report.finishedAt - report.startedAt)),
    metric("assertions", `${passed}/${report.checks.length}`),
    metric("injected", String(metrics?.injected ?? report.injected.length)),
    metric("recovered", String(metrics?.recovered ?? "—")),
    metric("recovery", metrics ? `${Math.round(metrics.recoveryRate * 100)}%` : "—"),
    metric("mttr", metrics?.mttrMs != null ? fmtMs(metrics.mttrMs) : "—"),
    metric("resume", metrics?.resumeSuccess == null ? "—" : metrics.resumeSuccess ? "ok" : "fail"),
    metric("orphans", String(metrics?.orphanCount ?? "—")),
    metric("dup tools", String(metrics?.duplicateToolIds.length ?? 0)),
    metric("diverge", metrics?.stateDivergence ? "yes" : "no"),
    metric("takeover", String(metrics?.userInterventionCount ?? 0)),
  ].join("");
  const risk = report.risk
    ? `<dl class="meta">
        <div><dt>status</dt><dd>${escape(report.risk.status)}</dd></div>
        <div><dt>workspace writes</dt><dd>${yn(report.risk.writesWorkspace)}</dd></div>
        <div><dt>kills process</dt><dd>${yn(report.risk.killsProcess)}</dd></div>
        <div><dt>proxy</dt><dd>${yn(report.risk.usesProxy)}</dd></div>
      </dl>${report.risk.notes.length ? `<p class="muted">${escape(report.risk.notes.join(" · "))}</p>` : ""}`
    : "";
  const env = report.env
    ? Object.entries(report.env)
        .map(([k, v]) => `<div><dt>${escape(k)}</dt><dd class="mono">${escape(v)}</dd></div>`)
        .join("")
    : "";
  const body = `
<header class="hero">
  <div>
    <p class="kicker">AgentChaos evaluation</p>
    <h1>${escape(report.name)}</h1>
    <p class="sub mono">${escape(report.id)}</p>
  </div>
  <span class="pill xl ${report.passed ? "ok" : "fail"}">${report.passed ? "pass" : "fail"}</span>
</header>
<section class="cards">${cards}</section>
<section class="grid">
  <article>
    <h2>Scores</h2>
    <table class="scores"><thead><tr><th>assertion</th><th>score</th><th>detail</th></tr></thead><tbody>${scores}</tbody></table>
  </article>
  <article>
    <h2>Run</h2>
    <dl class="meta">
      <div><dt>command</dt><dd class="mono">${escape(report.command.join(" "))}</dd></div>
      <div><dt>exit</dt><dd class="mono">${report.result.code ?? "null"} / ${escape(String(report.result.signal ?? "none"))}</dd></div>
      <div><dt>timed out</dt><dd>${yn(report.result.timedOut)}</dd></div>
      <div><dt>workspace</dt><dd class="mono">${escape(report.workspace)}</dd></div>
      ${report.workspaceHash?.start ? `<div><dt>hash</dt><dd class="mono">${escape(report.workspaceHash.start)} → ${escape(report.workspaceHash.end ?? "")}</dd></div>` : ""}
    </dl>
    <h2>Faults</h2>
    <div class="tags">${faults}</div>
    ${risk ? `<h2>Risk</h2>${risk}` : ""}
    ${env ? `<h2>Environment</h2><dl class="meta">${env}</dl>` : ""}
  </article>
</section>
<section>
  <div class="trace-head">
    <h2>Trace</h2>
    ${truncated ? `<p class="muted">showing last ${shown.length} of ${events.length} events</p>` : ""}
    <div class="filters">
      <button type="button" class="on" data-filter="all">all</button>
      <button type="button" data-filter="fault">faults</button>
      <button type="button" data-filter="assert">scores</button>
      <button type="button" data-filter="agent">agent</button>
    </div>
  </div>
  <div class="trace">${trace}</div>
</section>`;
  return shell(`${report.passed ? "pass" : "fail"} · ${report.name}`, body, TRACE_SCRIPT);
}

export function renderSuiteHtml(report: {
  id: string;
  name: string;
  repeat: number;
  trials: { experiment: string; name: string; trial: number; runId: string; passed: boolean }[];
  passK: Record<string, { passed: number; total: number; passHatK: boolean }>;
  passed: boolean;
}): string {
  const rows = Object.entries(report.passK)
    .map(
      ([name, k]) => `<tr>
        <td>${escape(name)}</td>
        <td class="mono">${k.passed}/${k.total}</td>
        <td><span class="pill ${k.passHatK ? "ok" : "fail"}">${k.passHatK ? "pass^k" : "fail"}</span></td>
      </tr>`,
    )
    .join("");
  const trials = report.trials
    .map(
      (t) => `<tr>
        <td class="mono">${t.trial}</td>
        <td>${escape(t.name)}</td>
        <td><span class="pill ${t.passed ? "ok" : "fail"}">${t.passed ? "pass" : "fail"}</span></td>
        <td class="mono"><a href="../${escape(t.runId)}/report.html">${escape(t.runId)}</a></td>
      </tr>`,
    )
    .join("");
  const passed = report.trials.filter((t) => t.passed).length;
  const body = `
<header class="hero">
  <div>
    <p class="kicker">AgentChaos suite · pass^k</p>
    <h1>${escape(report.name)}</h1>
    <p class="sub mono">suite-${escape(report.id)}</p>
  </div>
  <span class="pill xl ${report.passed ? "ok" : "fail"}">${report.passed ? "pass" : "fail"}</span>
</header>
<section class="cards">
  ${metric("repeat", String(report.repeat))}
  ${metric("experiments", String(Object.keys(report.passK).length))}
  ${metric("trials", `${passed}/${report.trials.length}`)}
  ${metric("pass^k", report.passed ? "1" : "0")}
</section>
<section class="grid">
  <article>
    <h2>Scores</h2>
    <table class="scores"><thead><tr><th>experiment</th><th>passed</th><th>pass^k</th></tr></thead><tbody>${rows}</tbody></table>
  </article>
  <article>
    <h2>Trials</h2>
    <table class="scores"><thead><tr><th>#</th><th>name</th><th>score</th><th>run</th></tr></thead><tbody>${trials}</tbody></table>
  </article>
</section>`;
  return shell(`${report.passed ? "pass" : "fail"} · ${report.name}`, body, "");
}

export function renderWorkflowHtml(report: {
  id: string;
  name: string;
  steps: { task: number; mode: string; experiment: string; name: string; runId: string; passed: boolean }[];
  passed: boolean;
}): string {
  const rows = report.steps
    .map(
      (s) => `<tr>
        <td class="mono">${s.task}</td>
        <td>${escape(s.mode)}</td>
        <td>${escape(s.name)}</td>
        <td><span class="pill ${s.passed ? "ok" : "fail"}">${s.passed ? "pass" : "fail"}</span></td>
        <td class="mono"><a href="../${escape(s.runId)}/report.html">${escape(s.runId)}</a></td>
      </tr>`,
    )
    .join("");
  const passed = report.steps.filter((s) => s.passed).length;
  const body = `
<header class="hero">
  <div>
    <p class="kicker">AgentChaos workflow</p>
    <h1>${escape(report.name)}</h1>
    <p class="sub mono">workflow-${escape(report.id)}</p>
  </div>
  <span class="pill xl ${report.passed ? "ok" : "fail"}">${report.passed ? "pass" : "fail"}</span>
</header>
<section class="cards">
  ${metric("steps", `${passed}/${report.steps.length}`)}
  ${metric("serial/parallel", report.steps.map((s) => s.mode).filter((v, i, a) => a.indexOf(v) === i).join(" + ") || "—")}
</section>
<section>
  <h2>Steps</h2>
  <table class="scores"><thead><tr><th>task</th><th>mode</th><th>experiment</th><th>score</th><th>run</th></tr></thead><tbody>${rows}</tbody></table>
</section>`;
  return shell(`${report.passed ? "pass" : "fail"} · ${report.name}`, body, "");
}

export function renderIndexHtml(runs: IndexRun[]): string {
  const rows = runs
    .map(
      (r) => `<tr>
        <td><span class="pill ${r.passed ? "ok" : "fail"}">${r.passed ? "pass" : "fail"}</span></td>
        <td><a href="${escape(r.href)}">${escape(r.name)}</a></td>
        <td class="muted">${escape(r.kind)}</td>
        <td class="mono">${r.durationMs != null ? fmtMs(r.durationMs) : "—"}</td>
        <td class="mono muted">${escape(r.id)}</td>
      </tr>`,
    )
    .join("");
  const passed = runs.filter((r) => r.passed).length;
  const body = `
<header class="hero">
  <div>
    <p class="kicker">AgentChaos</p>
    <h1>Evaluations</h1>
    <p class="sub">Local viewer · ${runs.length} runs</p>
  </div>
</header>
<section class="cards">
  ${metric("runs", String(runs.length))}
  ${metric("passed", `${passed}/${runs.length}`)}
  ${metric("failed", String(runs.length - passed))}
</section>
<section>
  <h2>Jobs</h2>
  <table class="scores">
    <thead><tr><th>score</th><th>name</th><th>kind</th><th>duration</th><th>id</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="muted">No runs yet. Execute: ${process.platform === "win32" ? ".\\agentchaos.cmd run examples\\codex-smoke.yaml" : "./agentchaos run examples/codex-smoke.yaml"}</td></tr>`}</tbody>
  </table>
</section>`;
  return shell("AgentChaos evaluations", body, INDEX_SCRIPT);
}

const INDEX_SCRIPT = `<script>
let last = null;
setInterval(async () => {
  try {
    const res = await fetch("/api/runs");
    const text = await res.text();
    if (last !== null && text !== last) location.reload();
    last = text;
  } catch {}
}, 3000);
</script>`;

export type IndexRun = {
  id: string;
  name: string;
  kind: string;
  passed: boolean;
  href: string;
  durationMs?: number;
  mtime?: number;
};

function renderMarkdown(report: Report, events: ChaosEvent[]): string {
  const passed = report.checks.filter((c) => c.passed).length;
  const checks = report.checks.map((c) => `- ${c.passed ? "pass" : "fail"} \`${c.assertion}\`${c.detail ? ` — ${c.detail}` : ""}`).join("\n");
  return `# ${report.name}

**${report.passed ? "PASS" : "FAIL"}** · \`${report.id}\`

| metric | value |
| --- | --- |
| duration | ${fmtMs(report.metrics?.durationMs ?? report.finishedAt - report.startedAt)} |
| assertions | ${passed}/${report.checks.length} |
| injected | ${(report.injected ?? []).join(", ") || "none"} |
| recovery | ${report.metrics ? `${Math.round(report.metrics.recoveryRate * 100)}%` : "—"} |
| mttr | ${report.metrics?.mttrMs != null ? fmtMs(report.metrics.mttrMs) : "—"} |
| resume | ${report.metrics?.resumeSuccess == null ? "—" : report.metrics.resumeSuccess ? "ok" : "fail"} |
| orphans | ${report.metrics?.orphanCount ?? "—"} |
| duplicate tools | ${(report.metrics?.duplicateToolIds ?? []).join(", ") || "none"} |
| state diverge | ${report.metrics?.stateDivergence ? "yes" : "no"} |
| user takeover | ${report.metrics?.userInterventionCount ?? 0} |

## Scores

${checks || "- none"}

## Trace

${events.map((e) => `- ${new Date(e.ts).toISOString()} \`${e.event}\``).join("\n")}
`;
}

function shell(title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>${body}</main>
${script}
</body>
</html>`;
}

function metric(label: string, value: string): string {
  return `<div class="card"><span class="label">${escape(label)}</span><strong>${escape(value)}</strong></div>`;
}

function eventKind(event: string): string {
  if (event.startsWith("fault") || event === "process_tree" || event === "shadow_compare") return "fault";
  if (event.startsWith("assertion")) return "assert";
  if (event.startsWith("agent") || event === "recovery_started") return "agent";
  return "sys";
}

function fmtDetail(detail: unknown): string {
  if (detail == null) return "";
  try {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
    return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  } catch {
    return "";
  }
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtRel(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  return `${sign}${fmtMs(Math.abs(ms))}`;
}

function yn(v: boolean): string {
  return v ? "yes" : "no";
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

const TRACE_SCRIPT = `<script>
document.querySelectorAll(".step").forEach((el) => {
  el.addEventListener("click", () => el.classList.toggle("open"));
});
document.querySelectorAll(".filters button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filters button").forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    const kind = btn.getAttribute("data-filter");
    document.querySelectorAll(".step").forEach((step) => {
      step.hidden = kind !== "all" && step.getAttribute("data-kind") !== kind;
    });
  });
});
</script>`;

const CSS = `
:root {
  --bg:#0b0c0e; --panel:#121417; --line:#23262b; --text:#e8eaed; --muted:#8b909a;
  --ok:#3dd68c; --fail:#ff5d5d; --fault:#f5a524; --agent:#7aa2ff; --sys:#6b7280;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text);
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { font-size: 28px; font-weight: 560; letter-spacing: -0.03em; margin: 0 0 6px; }
h2 { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--muted); margin: 0 0 12px; }
.kicker { color: var(--muted); letter-spacing: 0.12em; text-transform: uppercase; font-size: 11px; margin: 0 0 8px; }
.sub { color: var(--muted); margin: 0; }
.hero { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 28px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 28px; }
.card { background: var(--panel); border: 1px solid var(--line); padding: 12px 14px; }
.card .label { display: block; color: var(--muted); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 6px; }
.card strong { font-size: 20px; font-weight: 560; letter-spacing: -0.02em; }
.grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; margin-bottom: 28px; }
@media (max-width: 840px) { .grid { grid-template-columns: 1fr; } }
article { background: var(--panel); border: 1px solid var(--line); padding: 16px; }
.scores { width: 100%; border-collapse: collapse; }
.scores th, .scores td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
.scores th { color: var(--muted); font-weight: 500; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.pill { display: inline-block; border: 1px solid currentColor; padding: 1px 8px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
.pill.ok { color: var(--ok); } .pill.fail { color: var(--fail); }
.pill.xl { font-size: 12px; padding: 6px 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.muted { color: var(--muted); }
.meta { margin: 0 0 16px; }
.meta div { display: grid; grid-template-columns: 120px 1fr; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line); }
.meta dt { color: var(--muted); } .meta dd { margin: 0; word-break: break-all; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.tag { border: 1px solid var(--line); padding: 2px 8px; color: var(--fault); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.trace-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; }
.filters { display: flex; gap: 6px; }
.filters button, .step { background: transparent; color: inherit; }
.filters button { border: 1px solid var(--line); color: var(--muted); padding: 4px 8px; cursor: pointer; font: inherit; }
.filters button.on { color: var(--text); border-color: var(--text); }
.trace { border-left: 1px solid var(--line); margin-left: 7px; }
.step { display: block; width: 100%; text-align: left; border: 0; padding: 8px 8px 8px 18px; position: relative; cursor: pointer; font: inherit; }
.step:hover { background: var(--panel); }
.dot { position: absolute; left: -5px; top: 14px; width: 9px; height: 9px; background: var(--sys); }
.dot.fault { background: var(--fault); } .dot.assert { background: var(--ok); } .dot.agent { background: var(--agent); }
.t { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; margin-right: 10px; }
.ev { font-weight: 550; }
.state { color: var(--muted); margin-left: 8px; font-size: 11px; }
.detail { display: none; margin: 8px 0 0; padding: 10px; background: var(--bg); color: var(--muted); white-space: pre-wrap; max-height: 220px; overflow: auto; }
.step.open .detail { display: block; }
a { color: var(--agent); text-decoration: none; } a:hover { text-decoration: underline; }
`;
