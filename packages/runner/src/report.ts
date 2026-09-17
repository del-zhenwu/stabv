import { readdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult } from "./assertions.ts";
import type { ChaosEvent } from "./events.ts";
import type { RiskPreview } from "./capabilities.ts";
import type { DiagnosisReport, EvidenceProvenance, InvariantViolation } from "./spec.ts";
import type { AutoDecision } from "./auto-planner.ts";
import { comboLabel } from "./inject.ts";

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
  lostToolResults: number;
  llmHits?: number;
  llmTriggered?: number;
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
  verdict?: "pass" | "fail" | "inconclusive";
  blockReason?: string;
  events: string;
  metrics?: Metrics;
  risk?: RiskPreview;
  env?: Record<string, string>;
  workspaceHash?: { start?: string; end?: string };
  autoDecisions?: AutoDecision[];
  /** Old report.json field from the removed PRNG planner. Read via plannerDecisions(). */
  nemesisDecisions?: AutoDecision[];
  ioStalled?: boolean;
  retryStormDetected?: boolean;
  diagnosis?: DiagnosisReport;
  screenshots?: string[];
  agent?: string;
  inject?: string[];
};

export function plannerDecisions(report: Pick<Report, "autoDecisions" | "nemesisDecisions">): AutoDecision[] {
  if (report.autoDecisions?.length) return report.autoDecisions;
  return report.nemesisDecisions ?? [];
}

export function classifyRun(
  report: Pick<Report, "passed" | "checks" | "injected" | "result">,
  events: ChaosEvent[] = [],
): { verdict: "pass" | "fail" | "inconclusive"; blockReason?: string } {
  const checks = report.checks ?? [];
  const missingFaults = checks.filter((c) => c.assertion.startsWith("fault_injected:") && !c.passed);
  if (missingFaults.length) {
    return {
      verdict: "inconclusive",
      blockReason: setupBlockReason(
        events,
        missingFaults.map((c) => c.assertion.replace("fault_injected:", "")),
      ),
    };
  }
  if (report.passed && checks.every((c) => c.passed)) return { verdict: "pass" };
  return { verdict: "fail" };
}

function setupBlockReason(events: ChaosEvent[], planned: string[]): string {
  const plannedText = planned.join(", ") || "fault";
  const blob = events
    .filter((e) => e.event === "agent_output")
    .map((e) => String((e.detail as { line?: string } | undefined)?.line ?? ""))
    .join("\n")
    .toLowerCase();
  if (blob.includes("captcha")) {
    return `Provider captcha/login blocked the agent before planned ${plannedText} was injected. This is a setup failure, not an agent reliability fail.`;
  }
  if (blob.includes("providerbusinesserror") || blob.includes("unauthorized") || blob.includes("not logged in")) {
    return `Upstream provider/auth rejected the agent before planned ${plannedText} was injected. This is a setup failure, not an agent reliability fail.`;
  }
  return `Planned fault never injected (${plannedText}). The experiment did not reach the chaos window, so this is inconclusive — not an agent reliability fail.`;
}

export function generateDiagnosis(report: Report, events: ChaosEvent[]): DiagnosisReport {
  const classified = classifyRun(report, events);
  if (classified.verdict === "inconclusive") {
    return {
      schemaVersion: "agentchaos.dev/v1alpha1/diagnosis",
      runId: report.id,
      experimentName: report.name,
      target: {
        adapter: report.command?.[0] || "unknown",
        executable: (report.command ?? []).join(" "),
      },
      verdict: "INCONCLUSIVE",
      invariantsViolated: [],
      evidenceSummary: { empiricalCount: events.length, staticCount: 0, inferredCount: 0 },
      metrics: {
        durationMs: report.metrics?.durationMs ?? (report.finishedAt - report.startedAt),
        blockReason: classified.blockReason,
      },
    };
  }
  const violations: InvariantViolation[] = [];

  // Check 1: Retry Storm Deadlock
  const hasRetryStorm = report.retryStormDetected || events.some((e) => e.event === "watchdog_retry_storm");
  if (hasRetryStorm) {
    const causalChain = events
      .filter((e) => e.event === "fault_injected" || e.event === "watchdog_retry_storm" || (e.event === "agent_output" && (e.detail as any)?.stream === "stderr"))
      .slice(-6)
      .map((e, idx) => ({
        step: idx + 1,
        event: e.event,
        atMs: e.ts - report.startedAt,
        detail: typeof e.detail === "object" && e.detail !== null ? (e.detail as Record<string, unknown>) : { value: e.detail },
      }));
    violations.push({
      invariant: "RETRY_STORM_DEADLOCK",
      severity: "CRITICAL",
      summary: "Agent entered an unmitigated high-frequency retry loop upon encountering errors",
      provenance: "empirical",
      causalChain,
      suggestedFixPattern: {
        strategy: "EXPONENTIAL_BACKOFF_WITH_CEILING_AND_CIRCUIT_BREAKER",
        description: "Enforce a maximum retry ceiling (e.g. 3 attempts) and circuit-break on repeated 429/500 rather than looping endlessly.",
      },
    });
  }

  // Check 2: Unbounded Timeout / Deadlock
  if (report.result.timedOut || report.ioStalled) {
    const causalChain = events
      .filter((e) => e.event === "auto_strike" || e.event === "nemesis_disruption" || e.event === "fault_injected" || e.event === "agent_output" || e.event === "watchdog_io_stalled")
      .slice(-6)
      .map((e, idx) => ({
        step: idx + 1,
        event: e.event,
        atMs: e.ts - report.startedAt,
        detail: typeof e.detail === "object" && e.detail !== null ? (e.detail as Record<string, unknown>) : { value: e.detail },
      }));
    violations.push({
      invariant: "UNBOUNDED_RETRY_OR_DEADLOCK",
      severity: "CRITICAL",
      summary: report.ioStalled
        ? "Agent process ceased I/O output and became unresponsive during fault injection"
        : "Agent failed to self-heal within timeout deadline upon fault",
      provenance: "empirical",
      causalChain,
      suggestedFixPattern: {
        strategy: "CIRCUIT_BREAKER_AND_TIMEOUT",
        description: "Enforce a maximum retry ceiling and an overall per-turn AbortController timeout on network/tool interactions.",
      },
    });
  }

  // Check 2: Side-effect Idempotence (At-most-once violation)
  const failedDupCheck = report.checks.find((c) => c.assertion === "no_duplicate_tool_side_effect" && !c.passed);
  if (failedDupCheck || (report.metrics?.duplicateSideEffectRate ?? 0) > 0) {
    violations.push({
      invariant: "AT_MOST_ONCE_TOOL_SIDE_EFFECT_VIOLATION",
      severity: "HIGH",
      summary: "Duplicate tool call execution occurred across retries, violating idempotence invariants",
      provenance: "empirical",
      suggestedFixPattern: {
        strategy: "TOOL_CALL_DEDUPLICATION_BARRIER",
        description: "Cache executed tool results keyed by toolCallId before retrying failed network turns.",
      },
    });
  }

  // Check 3: Process Isolation / Orphan Leak
  const failedOrphanCheck = report.checks.find((c) => c.assertion === "no_orphan_process" && !c.passed);
  if (failedOrphanCheck || (report.metrics?.orphanCount ?? 0) > 0) {
    violations.push({
      invariant: "ORPHAN_PROCESS_LEAK",
      severity: "HIGH",
      summary: "Terminated agent process left lingering orphan child processes in the background",
      provenance: "empirical",
      suggestedFixPattern: {
        strategy: "PROCESS_GROUP_AND_JOB_OBJECT_ISOLATION",
        description: "Spawn child commands inside a dedicated POSIX process group or Windows Job Object with KILL_ON_JOB_CLOSE.",
      },
    });
  }

  // Check 4: MCP Upstream Consistency
  const failedMcpUpstream = report.checks.find((c) => c.assertion === "mcp_stdio_upstream_consistent" && !c.passed);
  if (failedMcpUpstream) {
    violations.push({
      invariant: "MCP_UPSTREAM_SIDE_EFFECT_POLLUTION",
      severity: "HIGH",
      summary: "MCP stdio proxy repeated upstream side-effecting operations rather than using cached responses",
      provenance: "empirical",
      suggestedFixPattern: {
        strategy: "PERSISTENT_RESPONSE_JOURNAL_REPLAY",
        description: "Verify that requests with identical signatures resolve from journal cache on resume.",
      },
    });
  }

  // Check 5: Subagent State Desynchronization
  const failedSubagentCheckpoint = report.checks.find((c) => c.assertion === "subagent_checkpoint_restored" && !c.passed);
  if (failedSubagentCheckpoint) {
    violations.push({
      invariant: "SUBAGENT_STATE_DESYNCHRONIZATION",
      severity: "HIGH",
      summary: "Subagent failed without properly restoring workspace to its pre-dispatch checkpoint",
      provenance: "empirical",
      suggestedFixPattern: {
        strategy: "TRANSACTIONAL_WORKSPACE_CHECKPOINT",
        description: "Capture git/workspace snapshot before spawning subagents and rollback on unhandled exit.",
      },
    });
  }

  const empiricalCount = events.length;
  const staticCount = 0;
  const inferredCount = violations.length;

  return {
    schemaVersion: "agentchaos.dev/v1alpha1/diagnosis",
    runId: report.id,
    experimentName: report.name,
    target: {
      adapter: report.command[0] || "unknown",
      executable: report.command.join(" "),
    },
    verdict: violations.length === 0 && report.passed ? "PASSED" : "FAILED",
    invariantsViolated: violations,
    evidenceSummary: {
      empiricalCount,
      staticCount,
      inferredCount,
    },
    metrics: {
      durationMs: report.metrics?.durationMs ?? (report.finishedAt - report.startedAt),
      recoveryRate: report.metrics?.recoveryRate ?? (report.passed ? 1 : 0),
      orphanCount: report.metrics?.orphanCount ?? 0,
      ioStalled: Boolean(report.ioStalled),
    },
    reproductionSpecSnippet: plannerDecisions(report).length
      ? `# Replay these mode: auto strikes as explicit faults:\nfaults:\n${plannerDecisions(report)
          .map((d) => `  - type: ${d.fault.kind}\n    action: ${d.fault.action}\n    at: ${d.atMs}ms\n    duration: ${d.fault.durationMs ?? 1000}ms`)
          .join("\n")}`
      : undefined,
  };
}

export async function writeReport(runRoot: string, report: Report, events: ChaosEvent[]): Promise<void> {
  // Discover any screenshot png files in runRoot
  try {
    if (existsSync(runRoot)) {
      const files = readdirSync(runRoot);
      report.screenshots = files.filter((f) => f.endsWith(".png")).map((f) => f);
    }
  } catch {
    /* ignore */
  }

  const classified = classifyRun(report, events);
  report.verdict = classified.verdict;
  report.blockReason = classified.blockReason;
  const diagnosis = generateDiagnosis(report, events);
  report.diagnosis = diagnosis;

  await writeFile(join(runRoot, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(runRoot, "report.diagnosis.json"), JSON.stringify(diagnosis, null, 2));
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
    status?: "running" | "done";
    agent?: string;
    inject?: string[];
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
    status?: "running" | "done";
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
  const worktreeDivergence = events.some((e) => {
    if (e.event !== "shadow_compare") return false;
    const detail = e.detail as { git?: { worktreesLocked?: boolean; worktrees?: number }; phase?: string } | undefined;
    return detail?.phase === "end" && (detail.git?.worktreesLocked === true || (detail.git?.worktrees ?? 0) > 1);
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
    stateDivergence: lockAfterRecover || processAliveAfterKill || worktreeDivergence,
    orphanCount,
    resumeAttempts,
    restarts,
    resumeSuccess,
    reworkRatio,
    userInterventionCount: ctx.cancelled ? 1 : 0,
    shadowSnapshots: events.filter((e) => e.event === "shadow_compare").length,
    lostToolResults: countLostToolResults(events),
  };
}

export function renderHtml(report: Report, events: ChaosEvent[]): string {
  const checks = report.checks ?? [];
  const passed = checks.filter((c) => c.passed).length;
  const scores = checks
    .map(
      (c) => `<tr>
        <td class="mono">${escape(c.assertion)} <span class="badge empirical">empirical</span></td>
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
        <span class="t" title="${escape(fmtClock(e.ts))}">${fmtRel(e.ts - origin)}</span>
        <span class="clock">${escape(fmtClock(e.ts, { timeOnly: true }))}</span>
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
    metric("assertions", `${passed}/${checks.length}`),
    metric("injected", String(metrics?.injected ?? (report.injected ?? []).length)),
    metric("recovered", String(metrics?.recovered ?? "—")),
    metric("recovery", metrics ? `${Math.round(metrics.recoveryRate * 100)}%` : "—"),
    metric("mttr", metrics?.mttrMs != null ? fmtMs(metrics.mttrMs) : "—"),
    metric("resume", metrics?.resumeSuccess == null ? "—" : metrics.resumeSuccess ? "ok" : "fail"),
    metric("orphans", String(metrics?.orphanCount ?? "—")),
    metric("dup tools", String(metrics?.duplicateToolIds.length ?? 0)),
    metric("llm hit", metrics?.llmTriggered != null ? `${metrics.llmTriggered}/${metrics.llmHits ?? 0}` : "—"),
    metric("diverge", metrics?.stateDivergence ? "yes" : "no"),
    metric("takeover", String(metrics?.userInterventionCount ?? 0)),
    metric("lost tools", String(metrics?.lostToolResults ?? 0)),
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

  const violationsHtml = (report.diagnosis?.invariantsViolated ?? []).length > 0
    ? `<section class="diagnosis-section">
        <h2>Coding Agent Reliability Diagnosis <span class="badge empirical">EMPIRICAL EVIDENCE</span></h2>
        ${(report.diagnosis?.invariantsViolated ?? []).map((v) => `
          <div class="diagnosis-box">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <strong style="color:var(--fail);font-size:14px;">${escape(v.invariant)}</strong>
              <span class="pill fail">${escape(v.severity)}</span>
            </div>
            <p style="margin:0 0 10px;">${escape(v.summary)}</p>
            ${v.causalChain?.length ? `
              <div class="mono muted" style="font-size:11px;margin-bottom:4px;">Observed Causal Sequence:</div>
              <ol class="causal-list">
                ${v.causalChain.map((step) => `<li><strong>${fmtRel(step.atMs ?? 0)}</strong>: [${escape(step.event)}] <span class="mono">${escape(JSON.stringify(step.detail ?? {}))}</span></li>`).join("")}
              </ol>` : ""}
            ${v.suggestedFixPattern ? `
              <div class="fix-box">
                <strong>Suggested Fix (${escape(v.suggestedFixPattern.strategy)}):</strong>
                <div style="margin-top:2px;">${escape(v.suggestedFixPattern.description)}</div>
              </div>` : ""}
          </div>
        `).join("")}
      </section>`
    : "";

  const screenshotsHtml = (report.screenshots ?? []).length > 0
    ? `<section>
        <h2>Visual Evidence Gallery <span class="badge empirical">OS SCREENSHOT</span></h2>
        <div class="gallery">
          ${report.screenshots!.map((s) => `
            <div>
              <a href="${escape(s)}" target="_blank" rel="noopener noreferrer">
                <img src="${escape(s)}" alt="${escape(s)}" />
              </a>
              <p class="mono muted" style="margin:4px 0 0;font-size:11px;">${escape(s)}</p>
            </div>
          `).join("")}
        </div>
      </section>`
    : "";

  const decisions = plannerDecisions(report);
  const autoHtml = decisions.length > 0
    ? `<section>
        <h2>mode: auto strikes <span class="badge auto">AUTO</span></h2>
        <p class="muted" style="margin:0 0 10px;">Planner injected these faults during the run. Replay turns them into a fixed YAML sequence.</p>
        <div class="tags">
          ${decisions.map((d) => `<span class="tag" style="border-color:var(--fail);color:var(--fail)">${fmtRel(d.atMs)} ${d.fault.kind}.${d.fault.action}</span>`).join("")}
        </div>
        ${report.diagnosis?.reproductionSpecSnippet ? `
          <div class="fix-box mono" style="background:var(--panel);border:1px solid var(--line);white-space:pre;overflow:auto;margin-top:8px;">
${escape(report.diagnosis.reproductionSpecSnippet)}
          </div>` : ""}
      </section>`
    : "";

  const classified = classifyRun(report, events);
  const verdict = report.verdict ?? classified.verdict;
  const blockReason = report.blockReason ?? classified.blockReason;
  const pillClass = verdict === "pass" ? "ok" : verdict === "inconclusive" ? "block" : "fail";
  const pillText = verdict === "pass" ? "pass" : verdict === "inconclusive" ? "inconclusive" : "fail";
  const blockBanner = blockReason
    ? `<section class="diagnosis-box" style="border-left-color:var(--fault);">
        <strong>Inconclusive — experiment did not run</strong>
        <p style="margin:8px 0 0;">${escape(blockReason)}</p>
      </section>`
    : "";
  const body = `
<header class="hero">
  <div>
    <p class="kicker">${escape(comboLabel(report.agent, report.inject).replace(" · ", " × ") || "AgentChaos evaluation")}</p>
    <h1>${escape(report.name)}</h1>
    <p class="sub">${escape(fmtClock(report.startedAt))} → ${escape(fmtClock(report.finishedAt))} · ${fmtMs(metrics?.durationMs ?? report.finishedAt - report.startedAt)}</p>
    <p class="sub mono">${escape(report.id)}</p>
  </div>
  <span class="pill xl ${pillClass}">${pillText}</span>
</header>
${blockBanner}
<section class="cards">${cards}</section>
${violationsHtml}
${screenshotsHtml}
${autoHtml}
<section class="grid">
  <article>
    <h2>Scores</h2>
    <table class="scores"><thead><tr><th>assertion</th><th>score</th><th>detail</th></tr></thead><tbody>${scores}</tbody></table>
  </article>
  <article>
    <h2>Run</h2>
    <dl class="meta">
      <div><dt>started</dt><dd class="mono">${escape(fmtClock(report.startedAt))}</dd></div>
      <div><dt>finished</dt><dd class="mono">${escape(fmtClock(report.finishedAt))}</dd></div>
      <div><dt>command</dt><dd class="mono">${escape((report.command ?? []).join(" "))}</dd></div>
      <div><dt>exit</dt><dd class="mono">${report.result?.code ?? "null"} / ${escape(String(report.result?.signal ?? "none"))}</dd></div>
      <div><dt>timed out</dt><dd>${yn(Boolean(report.result?.timedOut))}</dd></div>
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
  return shell(`${pillText} · ${report.name}`, body, TRACE_SCRIPT);
}

export function renderSuiteHtml(
  report: {
    id: string;
    name: string;
    repeat: number;
    trials: { experiment: string; name: string; trial: number; runId: string; passed: boolean; verdict?: "pass" | "fail" | "inconclusive" }[];
    passK: Record<string, { passed: number; total: number; passHatK: boolean }>;
    passed: boolean;
    status?: "running" | "done";
    agent?: string;
    inject?: string[];
  },
  opts?: { caseHref?: (runId: string) => string },
): string {
  const rows = Object.entries(report.passK)
    .map(
      ([name, k]) => `<tr>
        <td>${escape(name)}</td>
        <td class="mono">${k.passed}/${k.total}</td>
        <td><span class="pill ${k.passHatK ? "ok" : "fail"}">${k.passHatK ? "pass^k" : "fail"}</span></td>
      </tr>`,
    )
    .join("");
  const caseHref = (runId: string) => opts?.caseHref?.(runId) ?? `../${runId}/report.html`;
  const trials = report.trials
    .map(
      (t) => `<tr>
        <td class="mono">${t.trial}</td>
        <td>${escape(t.name)}</td>
        <td><span class="pill ${t.verdict === "inconclusive" ? "block" : t.passed ? "ok" : "fail"}">${t.verdict === "inconclusive" ? "n/a" : t.passed ? "pass" : "fail"}</span></td>
        <td class="mono"><a href="${escape(caseHref(t.runId))}">${escape(t.runId)}</a></td>
      </tr>`,
    )
    .join("");
  const passed = report.trials.filter((t) => t.passed).length;
  const running = report.status === "running";
  const body = `
<header class="hero">
  <div>
    <p class="kicker">${escape(comboLabel(report.agent, report.inject).replace(" · ", " × ") || "AgentChaos suite · pass^k")}</p>
    <h1>${escape(report.name)}</h1>
    <p class="sub mono">suite-${escape(report.id)}</p>
  </div>
  <span class="pill xl ${running ? "run" : report.passed ? "ok" : "fail"}">${running ? "run" : report.passed ? "pass" : "fail"}</span>
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
  status?: "running" | "done";
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
  const running = report.status === "running";
  const body = `
<header class="hero">
  <div>
    <p class="kicker">AgentChaos workflow</p>
    <h1>${escape(report.name)}</h1>
    <p class="sub mono">workflow-${escape(report.id)}</p>
  </div>
  <span class="pill xl ${running ? "run" : report.passed ? "ok" : "fail"}">${running ? "run" : report.passed ? "pass" : "fail"}</span>
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
  const tasks = runs.filter((r) => r.kind === "suite" || r.kind === "workflow");
  const standalone = runs.filter((r) => r.kind === "experiment");
  const primary = groupByTask(tasks.length ? tasks : standalone);
  const extra = tasks.length ? groupByTask(standalone) : [];
  const passed = primary.filter((g) => g.latest.status !== "running" && g.latest.passed).length;
  const failed = primary.filter((g) => g.latest.status !== "running" && !g.latest.passed).length;
  const caseTotal = primary.reduce((n, g) => n + (g.latest.cases ?? (g.latest.kind === "experiment" ? 1 : 0)), 0);
  const casePassed = primary.reduce((n, g) => n + (g.latest.passedCases ?? (g.latest.kind === "experiment" && g.latest.passed ? 1 : 0)), 0);
  const empty = process.platform === "win32" ? ".\\agentchaos.cmd run examples\\probe\\codex-smoke.yaml" : "./agentchaos run examples/probe/codex-smoke.yaml";
  const extraCount = extra.reduce((n, g) => n + g.runs.length, 0);
  const extraTable = extra.length
    ? `<details class="extra"><summary>${extra.length} standalone experiments · ${extraCount} runs</summary>
  <table class="scores">
    <thead><tr><th>score</th><th>task</th><th>kind</th><th>cases</th><th>runs</th><th>latest</th></tr></thead>
    <tbody>${renderTaskGroups(extra)}</tbody>
  </table>
</details>`
    : "";
  const body = `
<header class="hero">
  <div>
    <p class="kicker">AgentChaos</p>
    <h1>Tasks</h1>
    <p class="sub">One row per Suite / Workflow${extra.length ? ` · ${extra.length} standalone experiments folded below` : ""}</p>
  </div>
</header>
<section class="cards">
  ${metric("tasks", String(primary.length))}
  ${metric("passed", `${passed}/${primary.length}`)}
  ${metric("failed", String(failed))}
  ${metric("cases", `${casePassed}/${caseTotal}`)}
</section>
<section>
  <h2>Tasks</h2>
  <table class="scores">
    <thead><tr><th>score</th><th>task</th><th>kind</th><th>cases</th><th>runs</th><th>latest</th></tr></thead>
    <tbody>${renderTaskGroups(primary) || `<tr><td colspan="6" class="muted">No runs yet. Execute: ${empty}</td></tr>`}</tbody>
  </table>
</section>
${extraTable}`;
  return shell("AgentChaos evaluations", body, INDEX_SCRIPT);
}

type TaskGroup = { name: string; kind: string; runs: IndexRun[]; latest: IndexRun };

function groupByTask(runs: IndexRun[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  const order: string[] = [];
  for (const run of runs) {
    const key = `${run.kind}:${run.name}`;
    const existing = groups.get(key);
    if (!existing) {
      const group = { name: run.name, kind: run.kind, runs: [run], latest: run };
      groups.set(key, group);
      order.push(key);
      continue;
    }
    existing.runs.push(run);
    if ((run.mtime ?? 0) > (existing.latest.mtime ?? 0)) existing.latest = run;
  }
  return order.map((key) => groups.get(key)!);
}

function renderTaskGroups(groups: TaskGroup[]): string {
  return groups
    .map((group) => {
      const latest = group.latest;
      const pillClass =
        latest.status === "running" ? "run" : latest.verdict === "inconclusive" ? "block" : latest.passed ? "ok" : "fail";
      const pillText =
        latest.status === "running" ? "run" : latest.verdict === "inconclusive" ? "n/a" : latest.passed ? "pass" : "fail";
      const cases = latest.cases != null ? `${latest.passedCases ?? 0}/${latest.cases}` : "—";
      return `<tr class="job">
        <td><span class="pill ${pillClass}">${pillText}</span></td>
        <td><a href="${escape(latest.href)}">${escape(group.name)}</a></td>
        <td class="muted">${escape(group.kind)}</td>
        <td class="mono">${cases}</td>
        <td class="mono">${group.runs.length}</td>
        <td class="mono muted">${escape(latest.id)}</td>
      </tr>`;
    })
    .join("");
}

const INDEX_SCRIPT = `<script>
try {
  const stream = new EventSource("/api/runs/stream");
  stream.addEventListener("runs", () => location.reload());
  stream.onerror = () => stream.close();
} catch {}
</script>`;

export type IndexRun = {
  id: string;
  name: string;
  kind: string;
  passed: boolean;
  href: string;
  durationMs?: number;
  mtime?: number;
  status?: "running" | "done";
  verdict?: "pass" | "fail" | "inconclusive";
  cases?: number;
  passedCases?: number;
  children?: IndexRun[];
};

function renderMarkdown(report: Report, events: ChaosEvent[]): string {
  const passed = report.checks.filter((c) => c.passed).length;
  const checks = report.checks.map((c) => `- ${c.passed ? "pass" : "fail"} \`${c.assertion}\` [EMPIRICAL]${c.detail ? ` — ${c.detail}` : ""}`).join("\n");
  const violations = (report.diagnosis?.invariantsViolated ?? []).map((v) => `### ${v.invariant} (${v.severity})
${v.summary}
${v.suggestedFixPattern ? `> **Fix Strategy (${v.suggestedFixPattern.strategy})**: ${v.suggestedFixPattern.description}` : ""}`).join("\n\n");

  const screenshots = (report.screenshots ?? []).map((s) => `![${s}](./${s})`).join("\n\n");
  const auto = plannerDecisions(report).map((d) => `- **+${d.atMs}ms**: \`${d.fault.kind}.${d.fault.action}\` (auto)`).join("\n");

  return `# ${report.name}

**${report.passed ? "PASS" : "FAIL"}** · \`${report.id}\`

| metric | value | provenance |
| --- | --- | --- |
| duration | ${fmtMs(report.metrics?.durationMs ?? report.finishedAt - report.startedAt)} | empirical |
| assertions | ${passed}/${report.checks.length} | empirical |
| injected | ${(report.injected ?? []).join(", ") || "none"} | empirical |
| recovery | ${report.metrics ? `${Math.round(report.metrics.recoveryRate * 100)}%` : "—"} | empirical |
| mttr | ${report.metrics?.mttrMs != null ? fmtMs(report.metrics.mttrMs) : "—"} | empirical |
| resume | ${report.metrics?.resumeSuccess == null ? "—" : report.metrics.resumeSuccess ? "ok" : "fail"} | empirical |
| orphans | ${report.metrics?.orphanCount ?? "—"} | empirical |
| duplicate tools | ${(report.metrics?.duplicateToolIds ?? []).join(", ") || "none"} | empirical |
| state diverge | ${report.metrics?.stateDivergence ? "yes" : "no"} | empirical |
| user takeover | ${report.metrics?.userInterventionCount ?? 0} | empirical |
| lost tools | ${report.metrics?.lostToolResults ?? 0} | empirical |

${violations ? `## Invariant Violations (Coding Agent Diagnosis)\n\n${violations}\n` : ""}
${auto ? `## mode: auto strikes\n\n${auto}\n` : ""}
${screenshots ? `## Visual Screenshots\n\n${screenshots}\n` : ""}

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
  if (
    event.startsWith("fault") ||
    event === "process_tree" ||
    event === "shadow_compare" ||
    event === "subagent_killed" ||
    event === "subagent_paused" ||
    event === "subagent_fault_attempted"
  ) {
    return "fault";
  }
  if (event.startsWith("assertion")) return "assert";
  if (
    event.startsWith("agent") ||
    event === "recovery_started" ||
    event === "tool_started" ||
    event === "tool_finished" ||
    event === "approval_requested" ||
    event === "compaction_started" ||
    event === "compaction_finished" ||
    event === "session_checkpoint" ||
    event === "subagent_started" ||
    event === "subagent_finished"
  ) {
    return "agent";
  }
  return "sys";
}

function countLostToolResults(events: ChaosEvent[]): number {
  const finished = new Set(
    events.filter((e) => e.event === "tool_finished" && e.toolCallId).map((e) => e.toolCallId as string),
  );
  const started = events.filter((e) => e.event === "tool_started");
  const lostNamed = started.filter((e) => e.toolCallId && !finished.has(e.toolCallId)).length;
  const startedAnon = started.filter((e) => !e.toolCallId).length;
  const finishedAnon = events.filter((e) => e.event === "tool_finished" && !e.toolCallId).length;
  return lostNamed + Math.max(0, startedAnon - finishedAnon);
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

function fmtClock(ms?: number, opts: { timeOnly?: boolean } = {}): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (opts.timeOnly) return time;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
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
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
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
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0, "calt" 0; }
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
.pill.ok { color: var(--ok); } .pill.fail { color: var(--fail); } .pill.run { color: var(--fault); } .pill.block { color: var(--fault); }
.scores tr.child td { color: var(--muted); }
.nest { padding-left: 18px; display: inline-block; }
details.extra { margin-top: 28px; }
details.extra summary { color: var(--muted); cursor: pointer; letter-spacing: 0.08em; text-transform: uppercase; font-size: 12px; font-weight: 600; margin-bottom: 12px; }
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
.clock { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; margin-right: 10px; }
.ev { font-weight: 550; }
.state { color: var(--muted); margin-left: 8px; font-size: 11px; }
.detail { display: none; margin: 8px 0 0; padding: 10px; background: var(--bg); color: var(--muted); white-space: pre-wrap; max-height: 220px; overflow: auto; }
.step.open .detail { display: block; }
a { color: var(--agent); text-decoration: none; } a:hover { text-decoration: underline; }
.badge { display: inline-block; padding: 1px 5px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-radius: 3px; vertical-align: middle; }
.badge.empirical { background: rgba(61, 214, 140, 0.15); color: var(--ok); border: 1px solid rgba(61, 214, 140, 0.4); }
.badge.static { background: rgba(122, 162, 255, 0.15); color: var(--agent); border: 1px solid rgba(122, 162, 255, 0.4); }
.badge.auto { background: rgba(255, 93, 93, 0.15); color: var(--fail); border: 1px solid rgba(255, 93, 93, 0.4); }
.diagnosis-box { background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--fail); padding: 14px 16px; margin-bottom: 12px; }
.causal-list { margin: 6px 0 10px; padding-left: 18px; }
.fix-box { background: rgba(61, 214, 140, 0.06); border: 1px dashed rgba(61, 214, 140, 0.35); padding: 8px 12px; font-size: 12px; }
.gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-bottom: 24px; }
.gallery img { width: 100%; border: 1px solid var(--line); border-radius: 2px; }
`;
