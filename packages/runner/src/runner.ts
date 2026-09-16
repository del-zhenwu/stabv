import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventStore } from "./events.ts";
import { HelperClient, type HelperTree } from "./helper.ts";
import { planLaunch, applyResumeArgs } from "./adapters.ts";
import { ConnectProxy, LlmProxy } from "./proxy.ts";
import { injectFault } from "./faults.ts";
import { runAssertions } from "./assertions.ts";
import { computeMetrics, writeReport, type Report } from "./report.ts";
import { prepareWorkspace } from "./workspace.ts";
import { applyPerturbations, faultLabel, type Experiment, type Fault } from "./spec.ts";
import { previewRisk } from "./capabilities.ts";
import { envSnapshot, fileExists, gitPorcelain, toolCallId, workspaceFingerprint } from "./observe.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RunResult = { exitCode: number; report: Report };

type AgentProc = {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  agentPid?: number;
};

export async function runExperiment(exp: Experiment, specPath?: string): Promise<RunResult> {
  const runId = randomUUID();
  const helper = HelperClient.discover();
  const helperCaps = ((await helper.caps()) as { capabilities?: string[] }).capabilities ?? [];
  const { runRoot, work } = await prepareWorkspace(exp, runId);
  await writeFile(join(runRoot, "experiment.json"), JSON.stringify(exp.raw ?? exp, null, 2));
  const events = new EventStore(runId, join(runRoot, "events.jsonl"));
  const network = exp.faults.some((f) => f.kind === "network") ? new ConnectProxy() : undefined;
  const llm = exp.faults.some((f) => f.kind === "llm") ? new LlmProxy() : undefined;
  const extraEnv: Record<string, string> = { AGENTCHAOS_RUN_ID: runId };
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
    await events.emit("proxy_started", { kind: "llm", port });
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
  let sessionId: string | undefined;
  let cancelled = false;
  let pendingResumeSessionId: string | undefined;
  let resumeVerified = false;
  let resumeMismatched: string | undefined;
  let lastInLoopRecoveryMs: number | undefined;
  let outputAfterRecovery = false;

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
    });
  };
  const onCancel = () => {
    cancelled = true;
  };
  process.once("SIGINT", onCancel);
  process.once("SIGTERM", onCancel);

  const startAgent = async () => {
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
    void events.emit("agent_output", { stream, line: truncate(line) });
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
      } catch {
        /* ignore */
      }
    }
  };

  const applyDueFaults = async (elapsed: number) => {
    for (const rec of [...recoveries]) {
      if (elapsed >= rec.at) {
        recoveries.splice(recoveries.indexOf(rec), 1);
        await rec.recover();
        lastInLoopRecoveryMs = Date.now();
        outputAfterRecovery = false;
      }
    }
    for (const fault of exp.faults) {
      if (done.has(fault) || elapsed < fault.atMs) continue;
      if ((fault.kind === "process" || fault.kind === "input") && !agentPid()) continue;
      done.add(fault);
      injected.push(faultLabel(fault));
      const recover = await injectFault(fault, {
        work,
        helper,
        events,
        getPid: agentPid,
        writeStdin: (data) => {
          agent?.child.stdin?.write(data);
        },
        closeStdin: () => {
          agent?.child.stdin?.end();
        },
        network,
        llm,
        children: helperChildren,
        restart: async () => {
          restartPending = true;
        },
      });
      // `resume: true` implies the restart loop: resuming a killed agent still
      // requires relaunching its process.
      if (
        fault.kind === "process" &&
        (fault.action === "restart" || (fault.action === "kill" && (exp.recovery.restart || exp.recovery.resume)))
      ) {
        restartPending = true;
      }
      if (fault.durationMs) recoveries.push({ at: fault.atMs + fault.durationMs, recover });
      await emitShadow(`fault:${faultLabel(fault)}`);
    }
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

  const started = Date.now();
  let result: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
  let startHash = "";
  try {
    await applyDueFaults(0);
    await startAgent();
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
      if (race.tag === "exit") {
        result = race.v;
        if (restartPending) {
          restartPending = false;
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
    for (const rec of recoveries) {
      try {
        await rec.recover();
      } catch {
        /* continue cleanup */
      }
    }
    for (const extra of helperChildren) {
      if (extra.exitCode == null && extra.pid) extra.kill("SIGKILL");
    }
    await killAgent();
    await network?.stop();
    await llm?.stop();
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
  const checks = await runAssertions(exp.assertions, {
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
