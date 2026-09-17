import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { repoRoot } from "./paths.ts";
import { EventStore } from "./events.ts";
import { HelperClient, type HelperTree } from "./helper.ts";
import { planLaunch, applyResumeArgs, zcodeCliEnv, usesDiscoveredZcodeCli, zcodeCliCredentialError } from "./adapters.ts";
import { applyPerturbations, faultDueAt, faultLabel, mergeRuntimeDefaultAssertions, type Experiment, type Fault } from "./spec.ts";
import { injectFault } from "./faults.ts";
import { previewRisk } from "./capabilities.ts";
import { envSnapshot, fileExists, gitPorcelain, toolCallId, workspaceFingerprint } from "./observe.ts";
import { classifyAgentEvent } from "./native-events.ts";
import { ConnectProxy, LlmProxy, McpProxy } from "./proxy.ts";
import { RemoteCoordinator } from "./remote.ts";
import { prepareWorkspace } from "./workspace.ts";
import { runAssertions } from "./assertions.ts";
import { computeMetrics, writeReport, type Report } from "./report.ts";
import { AutoPlanner } from "./auto-planner.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RunResult = { exitCode: number; report: Report };

type AgentProc = {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  agentPid?: number;
};

export async function runExperiment(exp: Experiment, specPath?: string): Promise<RunResult> {
  if (usesDiscoveredZcodeCli(exp.target)) {
    const credErr = zcodeCliCredentialError();
    if (credErr) throw new Error(credErr);
  }
  const runId = randomUUID();
  const helper = HelperClient.discover();
  const helperCaps = ((await helper.caps()) as { capabilities?: string[] }).capabilities ?? [];
  const { runRoot, work } = await prepareWorkspace(exp, runId);
  await writeFile(join(runRoot, "experiment.json"), JSON.stringify(exp.raw ?? exp, null, 2));
  const events = new EventStore(runId, join(runRoot, "events.jsonl"));
  const needsLlm =
    exp.mode === "auto" ||
    exp.faults.some((f) => f.kind === "llm" || f.kind === "rule" || f.kind === "context");
  const needsMcp = exp.mode === "auto" || exp.faults.some((f) => f.kind === "mcp");
  const needsNetwork = exp.faults.some((f) => f.kind === "network");
  const needsRemote = exp.faults.some((f) => f.kind === "remote");
  const network = needsNetwork ? new ConnectProxy() : undefined;
  const upstreamCandidate =
    process.env.AGENTCHAOS_LLM_UPSTREAM ??
    exp.target.env?.AGENTCHAOS_LLM_UPSTREAM ??
    (exp.target as any).llmUpstream ??
    (exp.target.adapter === "zcode" ? zcodeCliEnv().ZCODE_BASE_URL : undefined) ??
    process.env.ANTHROPIC_BASE_URL ??
    process.env.OPENAI_BASE_URL;

  const llmUpstream =
    upstreamCandidate &&
    !upstreamCandidate.includes("127.0.0.1:") &&
    !upstreamCandidate.includes("localhost:")
      ? upstreamCandidate
      : undefined;

  const llm = needsLlm ? new LlmProxy(llmUpstream) : undefined;
  if (llm) {
    llm.onTrigger = (detail) => {
      void events.emit("llm_fault_triggered", detail);
    };
  }
  const mcp = needsMcp ? new McpProxy() : undefined;
  const remote = needsRemote ? new RemoteCoordinator() : undefined;
  const extraEnv: Record<string, string> = { AGENTCHAOS_RUN_ID: runId };
  let sessionRoot: string | undefined;
  if (exp.target.sessionHome) {
    sessionRoot = join(runRoot, exp.target.sessionHome);
    await mkdir(sessionRoot, { recursive: true });
    if (exp.target.adapter === "codex") extraEnv.CODEX_HOME = sessionRoot;
    else if (exp.target.adapter === "claude") extraEnv.CLAUDE_CONFIG_DIR = sessionRoot;
  }
  if (exp.perturbations?.length) {
    extraEnv.AGENTCHAOS_PERTURBATION = exp.perturbations.map((p) => p.text).join("\n");
    if (exp.target.prompt) exp.target.prompt = applyPerturbations(exp.target.prompt, exp.perturbations);
  }
  if (network) {
    const port = await network.start();
    extraEnv.HTTP_PROXY = `http://127.0.0.1:${port}`;
    extraEnv.HTTPS_PROXY = extraEnv.HTTP_PROXY;
    extraEnv.http_proxy = extraEnv.HTTP_PROXY;
    extraEnv.https_proxy = extraEnv.HTTP_PROXY;
    extraEnv.NO_PROXY = "127.0.0.1,localhost";
    extraEnv.no_proxy = extraEnv.NO_PROXY;
    await events.emit("proxy_started", { kind: "network", port });
  }
  if (llm) {
    const port = await llm.start();
    extraEnv.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
    extraEnv.OPENAI_API_BASE = extraEnv.OPENAI_BASE_URL;
    extraEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    extraEnv.ANTHROPIC_API_URL = extraEnv.ANTHROPIC_BASE_URL;
    extraEnv.ZCODE_BASE_URL = `http://127.0.0.1:${port}`;
    if (exp.target.adapter === "zcode") {
      const zEnv = zcodeCliEnv();
      extraEnv.ZCODE_MODEL = zEnv.ZCODE_MODEL || "anthropic/GLM-5.3";
      const apiKey = zEnv.ZCODE_API_KEY;
      if (apiKey) extraEnv.ZCODE_API_KEY = apiKey;
    }
    await events.emit("proxy_started", { kind: "llm", port, upstream: llmUpstream });
  }
  const mcpPolicyFile = join(runRoot, "mcp-policy.json");
  const mcpJournalFile = join(runRoot, "mcp-stdio.jsonl");
  const subagentJournalFile = join(runRoot, "subagents.jsonl");
  await writeFile(mcpPolicyFile, JSON.stringify({ action: "pass" }));
  await writeFile(subagentJournalFile, "");
  extraEnv.AGENTCHAOS_MCP_POLICY_FILE = mcpPolicyFile;
  extraEnv.AGENTCHAOS_MCP_STDIO_BIN = resolve(repoRoot(), "bin/agentchaos-mcp-stdio.js");
  extraEnv.AGENTCHAOS_MCP_JOURNAL_FILE = mcpJournalFile;

  if (mcp) {
    const port = await mcp.start();
    const url = `http://127.0.0.1:${port}`;
    extraEnv.AGENTCHAOS_MCP_URL = url;
    extraEnv.MCP_URL = url;
    extraEnv.MCP_SERVER_URL = url;
    await events.emit("proxy_started", { kind: "mcp", port });
  }

  if (remote) {
    const url = await remote.start();
    extraEnv.AGENTCHAOS_REMOTE_URL = url;
    extraEnv.REMOTE_URL = url;
    await events.emit("proxy_started", { kind: "remote", url });
  }

  const plan = planLaunch(exp, extraEnv);
  let output = "";
  let timedOut = false;
  let state = "Idle";
  let agent: AgentProc | undefined;
  let restartPending = false;
  const helperChildren: ChildProcess[] = [];
  const recoveries: { at: number; recover: () => Promise<void> }[] = [];
  const injected: string[] = [];
  const done = new Set<Fault>();
  const toolIds = new Map<string, number>();
  const nativeAt = new Map<string, number>();
  const pendingTools = new Set<string>();
  const seenNative = new Set<string>();
  let lastNative: string | undefined;
  let lastSubagentId: string | undefined;
  let generation = 0;
  let started = 0;
  let sessionId: string | undefined;
  let cancelled = false;
  let pendingResumeSessionId: string | undefined;
  let resumeVerified = false;
  let resumeMismatched: string | undefined;
  let lastInLoopRecoveryMs: number | undefined;
  let outputAfterRecovery = false;
  const autoPlanner = exp.mode === "auto" ? new AutoPlanner({ budget: exp.budget, model: exp.llm?.model }) : undefined;
  let lastOutputAt = Date.now();
  let ioStallDetected = false;
  let retryStormDetected = false;
  const errorTimestamps: number[] = [];
  const retryThreshold = exp.retryStormThreshold ?? 4;
  const retryWindowMs = exp.retryStormWindowMs ?? 3000;

  const emitShadow = async (phase: string) => {
    const hash = await workspaceFingerprint(work);
    const git = exp.git
      ? { ...(await gitPorcelain(work)), indexLock: await fileExists(join(work, ".git/index.lock")) }
      : undefined;
    const pid = agent?.agentPid ?? agent?.child.pid;
    let processAlive: boolean | undefined;
    if (pid) {
      try {
        processAlive = (await helper.listTree(pid)).alive;
      } catch {
        processAlive = false;
      }
    }
    await events.emit("shadow_compare", {
      phase,
      harness: { injected: [...injected] },
      workspace: { hash },
      git,
      process: { pid, alive: processAlive },
      agent: {
        sessionId,
        lastNative,
        pendingTools: [...pendingTools],
        compacting: lastNative === "compaction_started",
        awaitingApproval: lastNative === "approval_requested",
      },
    });
  };
  const onCancel = () => {
    cancelled = true;
  };
  process.once("SIGINT", onCancel);
  process.once("SIGTERM", onCancel);

  const startAgent = async () => {
    generation += 1;
    state = "ExecutingTool";
    const env = { ...process.env, ...plan.env };
    const usePty = Boolean(exp.target.pty) && helperCaps.includes("pty");
    let child: ChildProcess;
    let agentPid: number | undefined;
    if (usePty) {
      const handle = helper.spawnPty({ cwd: work, env, argv: [plan.executable, ...plan.args] });
      child = handle.child;
      agentPid = await handle.agentPid;
    } else {
      if (exp.target.pty) {
        await events.emit("capability_degraded", { capability: "pty", using: "pipe" });
      }
      child = spawn(plan.executable, plan.args, {
        cwd: work,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      // Codex `exec` reads stdin when it is a pipe, even when the prompt is an argv.
      // Close it for non-interactive runs; input.send experiments keep it open.
      if (!exp.faults.some((fault) => fault.kind === "input" || fault.kind === "approval")) child.stdin?.end();
      agentPid = child.pid;
    }
    await writeFile(join(runRoot, "agent.pid"), String(agentPid ?? child.pid ?? ""));
    child.stdout?.on("data", (buf: Buffer) => onChunk("stdout", buf));
    child.stderr?.on("data", (buf: Buffer) => onChunk("stderr", buf));
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    agent = { child, exit, agentPid };
    await events.emit("agent_started", { pid: agentPid, helperPid: child.pid, pty: usePty, command: [plan.executable, ...plan.args] }, state);
  };

  const agentPid = () => agent?.agentPid ?? agent?.child.pid;
  const killAgent = async () => {
    const pids = [...new Set([agent?.agentPid, agent?.child.pid].filter((n): n is number => Boolean(n)))];
    for (const pid of pids) {
      try {
        await helper.killTree(pid);
      } catch {
        /* already dead */
      }
    }
  };

  const onChunk = (stream: string, buf: Buffer) => {
    const line = buf.toString();
    output += line;
    outputAfterRecovery = true;
    lastOutputAt = Date.now();
    void events.emit("agent_output", { stream, line: truncate(line) });

    const isErrStream = stream === "stderr";
    const looksLikeError =
      isErrStream ||
      /(APICallError|retry|rate limit|internal server error|Cannot connect to API|other side closed|ECONNREFUSED|ETIMEDOUT)/i.test(line);

    if (looksLikeError && !retryStormDetected) {
      const now = Date.now();
      errorTimestamps.push(now);
      while (errorTimestamps.length > 0 && now - errorTimestamps[0] > retryWindowMs) {
        errorTimestamps.shift();
      }
      if (errorTimestamps.length >= retryThreshold) {
        retryStormDetected = true;
        void events.emit("watchdog_retry_storm", {
          count: errorTimestamps.length,
          windowMs: retryWindowMs,
          threshold: retryThreshold,
          stream,
          sample: truncate(line.trim()),
          pid: agentPid(),
        });
      }
    }

    for (const piece of line.split("\n")) {
      const trimmed = piece.trim();
      if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
      try {
        const parsed = JSON.parse(trimmed);
        void events.emit("agent_event", parsed, inferState(parsed));
        const id = toolCallId(parsed);
        if (id) toolIds.set(id, (toolIds.get(id) ?? 0) + 1);
        const sid = sessionIdFromEvent(parsed);
        if (sid) {
          if (pendingResumeSessionId != null) {
            if (sid === pendingResumeSessionId) resumeVerified = true;
            else if (!resumeVerified) resumeMismatched ??= sid;
            pendingResumeSessionId = undefined;
          }
          sessionId = sid;
        }
        const native = classifyAgentEvent(parsed, exp.target.adapter);
        if (native) {
          lastNative = native.kind;
          seenNative.add(native.kind);
          if (!nativeAt.has(native.kind)) nativeAt.set(native.kind, Math.max(0, Date.now() - started));
          if (native.kind === "tool_started" && native.toolCallId) pendingTools.add(native.toolCallId);
          if (native.kind === "tool_finished" && native.toolCallId) pendingTools.delete(native.toolCallId);
          if ((native.kind === "subagent_started" || native.kind === "subagent_finished") && native.toolCallId) {
            lastSubagentId = native.toolCallId;
            appendFileSync(
              subagentJournalFile,
              JSON.stringify({
                ts: Date.now(),
                type: native.kind === "subagent_started" ? "started" : "finished",
                id: native.toolCallId,
                parentPid: agentPid(),
                sessionId,
                generation,
              }) + "\n",
            );
          }
          void events.emit(native.kind, native.detail, inferState(parsed), {
            toolCallId: native.toolCallId,
            sessionRevision: native.sessionRevision ?? sessionId,
          });
          void applyDueFaults(Math.max(0, Date.now() - started));
        }
      } catch {
        /* ignore */
      }
    }
  };

  const applyDueFaultsUnlocked = async (elapsed: number) => {
    for (const rec of [...recoveries]) {
      if (elapsed >= rec.at) {
        recoveries.splice(recoveries.indexOf(rec), 1);
        await rec.recover();
        lastInLoopRecoveryMs = Date.now();
        outputAfterRecovery = false;
      }
    }
    for (const fault of exp.faults) {
      if (done.has(fault) || elapsed < faultDueAt(fault, nativeAt)) continue;
      if (
        (fault.kind === "process" ||
          fault.kind === "input" ||
          fault.kind === "approval" ||
          fault.kind === "cancel" ||
          (fault.kind === "compaction" && fault.action === "interrupt") ||
          (fault.kind === "subagent" && fault.action !== "conflict")) &&
        !agentPid()
      ) {
        continue;
      }
      done.add(fault);
      injected.push(faultLabel(fault));
      const recover = await injectFault(fault, {
        work,
        runRoot,
        sessionRoot,
        helper,
        events,
        getPid: agentPid,
        writeStdin: (data) => {
          agent?.child.stdin?.write(data);
        },
        closeStdin: () => {
          agent?.child.stdin?.end();
        },
        sendSignal: (signal) => {
          agent?.child.kill(signal);
        },
        emitOutput: (stream, data) => onChunk(stream, Buffer.from(data)),
        network,
        llm,
        mcp,
        mcpPolicyFile,
        remote,
        children: helperChildren,
        recordSubagent: (record) => {
          appendFileSync(
            subagentJournalFile,
            JSON.stringify({ ts: Date.now(), ...record, id: record.id ?? lastSubagentId, parentPid: agentPid(), sessionId, generation }) + "\n",
          );
        },
        restart: async () => {
          restartPending = true;
        },
      });
      // `resume: true` implies the restart loop: resuming a killed agent still
      // requires relaunching its process.
      if (
        (fault.kind === "process" &&
          (fault.action === "restart" || (fault.action === "kill" && (exp.recovery.restart || exp.recovery.resume)))) ||
        (fault.kind === "compaction" && fault.action === "interrupt" && (exp.recovery.restart || exp.recovery.resume))
      ) {
        restartPending = true;
      }
      if (fault.durationMs) recoveries.push({ at: elapsed + fault.durationMs, recover });
      await emitShadow(`fault:${faultLabel(fault)}`);
    }
  };

  let faultGate: Promise<void> = Promise.resolve();
  const applyDueFaults = (elapsed: number): Promise<void> => {
    const next = faultGate.then(() => applyDueFaultsUnlocked(elapsed));
    faultGate = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  await events.emit(
    "run_started",
    {
      run_id: runId,
      name: exp.name,
      spec: specPath,
      command: [plan.executable, ...plan.args],
      workspace: work,
      helper: helper.path,
    },
    state,
  );

  started = Date.now();
  let result: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
  let startHash = "";
  try {
    await applyDueFaults(0);
    await startAgent();
    const injectPlannerFault = async (fault: Fault) => {
      injected.push(faultLabel(fault));
      return await injectFault(fault, {
        work,
        runRoot,
        sessionRoot,
        helper,
        events,
        getPid: agentPid,
        writeStdin: (data) => {
          agent?.child.stdin?.write(data);
        },
        closeStdin: () => {
          agent?.child.stdin?.end();
        },
        sendSignal: (signal) => {
          agent?.child.kill(signal);
        },
        emitOutput: (stream, data) => onChunk(stream, Buffer.from(data)),
        network,
        llm,
        mcp,
        mcpPolicyFile,
        remote,
        children: helperChildren,
        recordSubagent: (record) => {
          appendFileSync(
            subagentJournalFile,
            JSON.stringify({ ts: Date.now(), ...record, id: record.id ?? lastSubagentId, parentPid: agentPid(), sessionId, generation }) + "\n",
          );
        },
        restart: async () => {
          restartPending = true;
        },
      });
    };
    autoPlanner?.start(events, injectPlannerFault);
    const timeoutAt = started + exp.timeoutMs;
    startHash = await workspaceFingerprint(work);
    await events.emit("workspace_snapshot", { phase: "start", hash: startHash });
    if (exp.git) await events.emit("git_state", { phase: "start", ...(await gitPorcelain(work)) });
    await emitShadow("start");
    while (true) {
      if (!agent) break;
      if (cancelled) {
        await events.emit("run_cancelled", { reason: "signal" }, "Cancelled");
        await killAgent();
        result = await agent.exit.catch(() => ({ code: null, signal: "SIGTERM" as NodeJS.Signals }));
        break;
      }
      const remaining = timeoutAt - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        await killAgent();
        await events.emit("run_timeout", { timeoutMs: exp.timeoutMs });
        result = await agent.exit.catch(() => ({ code: null, signal: "SIGKILL" as NodeJS.Signals }));
        break;
      }
      const race = await Promise.race([
        agent.exit.then((v) => ({ tag: "exit" as const, v })),
        sleep(Math.min(50, remaining)).then(() => ({ tag: "tick" as const })),
      ]);
      await applyDueFaults(Date.now() - started);
      if (exp.ioStallTimeoutMs && !ioStallDetected && agent && Date.now() - lastOutputAt >= exp.ioStallTimeoutMs) {
        ioStallDetected = true;
        await events.emit("watchdog_io_stalled", {
          stalledDurationMs: Date.now() - lastOutputAt,
          thresholdMs: exp.ioStallTimeoutMs,
          pid: agentPid(),
        });
      }
      if (race.tag === "exit") {
        result = race.v;
        if (restartPending) {
          restartPending = false;
          appendFileSync(
            subagentJournalFile,
            JSON.stringify({ ts: Date.now(), type: "restart", generation, sessionId }) + "\n",
          );
          const resumed = exp.recovery.resume ? applyResumeArgs(plan, exp.target, sessionId) : false;
          await events.emit("recovery_started", { action: resumed ? "resume" : "restart", sessionId: resumed ? sessionId : undefined });
          if (resumed) pendingResumeSessionId = sessionId;
          await startAgent();
          continue;
        }
        break;
      }
    }
  } catch (err) {
    await events.emit("run_error", { error: String(err) });
    throw err;
  } finally {
    autoPlanner?.stop();
    for (const rec of recoveries) {
      try {
        await rec.recover();
      } catch {
        /* continue cleanup */
      }
    }
    for (const extra of helperChildren) {
      helper.stopWorker(extra);
    }
    helper.stopAllWorkers();
    await killAgent();
    await network?.stop();
    await llm?.stop();
    await mcp?.stop();
    await remote?.stop();
    process.off("SIGINT", onCancel);
    process.off("SIGTERM", onCancel);
  }

  let tree: HelperTree | undefined;
  const treePid = agentPid();
  if (treePid) {
    try {
      tree = await helper.listTree(treePid);
    } catch {
      tree = { root: treePid, alive: false, processes: [] };
    }
  }
  state = cancelled ? "Cancelled" : result.code === 0 && !timedOut ? "Completed" : "Failed";
  const endHash = await workspaceFingerprint(work);
  await events.emit("workspace_snapshot", { phase: "end", hash: endHash });
  if (exp.git) await events.emit("git_state", { phase: "end", ...(await gitPorcelain(work)) });
  await emitShadow("end");
  await events.emit("run_finished", { ...result, timedOut, cancelled }, state);

  const duplicateToolIds = [...toolIds.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  const assertions = exp.assertionsDefaulted
    ? mergeRuntimeDefaultAssertions(exp.assertions, injected)
    : exp.assertions;
  const checks = await runAssertions(assertions, {
    code: result.code,
    signal: result.signal,
    timedOut,
    work,
    output,
    injected,
    tree,
    verify: exp.verify,
    duplicateToolIds,
    sessionId,
    ephemeral: exp.target.ephemeral,
    expected: exp.expected,
    lastRecoveryInLoopMs: lastInLoopRecoveryMs,
    outputAfterRecovery,
    nativeEvents: [...seenNative],
    lostToolResults: pendingTools.size,
    mcpJournal: mcpJournalFile,
    subagentJournal: subagentJournalFile,
    remoteCoordinator: remote,
    runRoot,
    llmHits: llm?.hits,
    llmTriggered: llm?.triggered,
  });
  for (const check of checks) await events.emit("assertion_checked", check);

  const finishedAt = Date.now();
  const metrics = computeMetrics(events.events, started, finishedAt, duplicateToolIds, toolIds.size, {
    start: startHash,
    end: endHash,
    tree,
    cancelled,
    resumeVerified,
    resumeMismatched,
  });
  if (llm) {
    metrics.llmHits = llm.hits;
    metrics.llmTriggered = llm.triggered;
  }
  const report: Report = {
    id: runId,
    name: exp.name,
    startedAt: started,
    finishedAt,
    command: [plan.executable, ...plan.args],
    workspace: work,
    result: { ...result, timedOut, cancelled },
    injected,
    checks,
    passed: checks.every((c) => c.passed) && !cancelled,
    events: events.path,
    metrics,
    risk: previewRisk(exp, helperCaps),
    env: envSnapshot(),
    workspaceHash: { start: startHash || undefined, end: endHash },
    autoDecisions: autoPlanner?.getHistory() ?? [],
    ioStalled: ioStallDetected,
    retryStormDetected,
    agent: exp.agent,
    inject: exp.inject,
  };
  await writeReport(runRoot, report, events.events);
  await appendFile(join(runRoot, "..", "index.jsonl"), JSON.stringify({ id: runId, name: exp.name, passed: report.passed, ts: finishedAt, report: join(runRoot, "report.json") }) + "\n");
  console.log(
    JSON.stringify(
      { run_id: runId, passed: report.passed, checks, events: events.path, report: join(runRoot, "report.json"), html: join(runRoot, "report.html") },
      null,
      2,
    ),
  );
  return { exitCode: report.passed ? 0 : 1, report };
}

function truncate(line: string): string {
  return line.length > 4000 ? `${line.slice(0, 4000)}…` : line;
}

function inferState(event: { type?: string; event?: string }): string | undefined {
  const type = String(event?.type ?? event?.event ?? "");
  if (/approval/i.test(type)) return "AwaitingApproval";
  if (/compact/i.test(type)) return "Compacting";
  if (/stream/i.test(type)) return "Streaming";
  if (/tool/i.test(type)) return "ExecutingTool";
  if (/complete|done|finished/i.test(type)) return "Completed";
  return undefined;
}

function sessionIdFromEvent(event: Record<string, unknown>): string | undefined {
  for (const key of ["sessionId", "session_id", "thread_id", "threadId"] as const) {
    const value = event[key];
    if (typeof value === "string" && value) return value;
  }
  const nested = event.context;
  if (nested && typeof nested === "object") {
    const sid = (nested as { sessionId?: unknown }).sessionId;
    if (typeof sid === "string" && sid) return sid;
  }
  return undefined;
}
