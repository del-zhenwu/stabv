import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Assertion, ExpectedFile, VerifySpec } from "./spec.ts";
import type { HelperTree } from "./helper.ts";
import type { RemoteCoordinator } from "./remote.ts";
import { gitPorcelain, gitWorktrees, runVerify } from "./observe.ts";

export type CheckResult = { assertion: string; passed: boolean; detail?: string };

export type AssertionInput = {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  work: string;
  output: string;
  injected: string[];
  tree?: HelperTree;
  verify?: VerifySpec;
  duplicateToolIds?: string[];
  sessionId?: string;
  ephemeral?: boolean;
  expected?: ExpectedFile[];
  /** Wall-clock ms of the last fault recovery that happened while the run loop was active. */
  lastRecoveryInLoopMs?: number;
  /** The agent produced output after that recovery. */
  outputAfterRecovery?: boolean;
  nativeEvents?: string[];
  lostToolResults?: number;
  mcpJournal?: string;
  subagentJournal?: string;
  remoteCoordinator?: RemoteCoordinator;
  runRoot?: string;
  llmHits?: number;
  llmTriggered?: number;
};

export async function runAssertions(assertions: Assertion[], input: AssertionInput): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const assertion of assertions) {
    out.push(await checkOne(assertion, input));
  }
  return out;
}

async function checkOne(assertion: Assertion, input: AssertionInput): Promise<CheckResult> {
  switch (assertion.type) {
    case "exit_zero":
      return { assertion: assertion.type, passed: input.code === 0 && !input.timedOut };
    case "exit_nonzero":
      return { assertion: assertion.type, passed: input.code !== 0 || Boolean(input.signal) || input.timedOut };
    case "timed_out":
      return { assertion: assertion.type, passed: input.timedOut };
    case "not_timed_out":
      return { assertion: assertion.type, passed: !input.timedOut };
    case "file_exists":
      return { assertion: `file_exists:${assertion.path}`, passed: await exists(join(input.work, assertion.path)) };
    case "file_absent":
      return { assertion: `file_absent:${assertion.path}`, passed: !(await exists(join(input.work, assertion.path))) };
    case "file_contains": {
      let text = "";
      try {
        text = await readFile(join(input.work, assertion.path), "utf8");
      } catch {
        return { assertion: `file_contains:${assertion.path}`, passed: false, detail: "missing file" };
      }
      return {
        assertion: `file_contains:${assertion.path}`,
        passed: text.includes(assertion.text),
      };
    }
    case "output_contains":
      return { assertion: `output_contains:${assertion.text}`, passed: input.output.includes(assertion.text) };
    case "no_orphan_process": {
      const alive = (input.tree?.processes ?? []).filter((p) => p.pid !== input.tree?.root);
      const passed = !input.tree?.alive && alive.length === 0;
      return { assertion: "no_orphan_process", passed, detail: JSON.stringify(input.tree ?? null) };
    }
    case "fault_injected":
      return {
        assertion: `fault_injected:${assertion.fault}`,
        passed: input.injected.includes(assertion.fault),
      };
    case "llm_triggered":
      return {
        assertion: "llm_triggered",
        passed: (input.llmTriggered ?? 0) > 0,
        detail: `hits=${input.llmHits ?? 0} triggered=${input.llmTriggered ?? 0}`,
      };
    case "git_lock_absent":
      return { assertion: "git_lock_absent", passed: !(await exists(join(input.work, ".git/index.lock"))) };
    case "task_tests_pass": {
      if (!input.verify) return { assertion: "task_tests_pass", passed: false, detail: "missing spec.verify" };
      const result = await runVerify(input.work, input.verify.executable, input.verify.args);
      return { assertion: "task_tests_pass", passed: result.code === 0, detail: result.output.slice(0, 500) };
    }
    case "git_state_consistent": {
      const git = await gitPorcelain(input.work);
      const lock = await exists(join(input.work, ".git/index.lock"));
      return { assertion: "git_state_consistent", passed: git.ok && !lock, detail: git.text.slice(0, 500) };
    }
    case "no_duplicate_tool_side_effect":
      return {
        assertion: "no_duplicate_tool_side_effect",
        passed: (input.duplicateToolIds ?? []).length === 0,
        detail: (input.duplicateToolIds ?? []).join(","),
      };
    case "session_resumable":
      return {
        assertion: "session_resumable",
        passed: Boolean(input.sessionId) && input.ephemeral === false,
        detail: input.sessionId ?? "no session id",
      };
    case "workspace_matches_expected": {
      if (!input.expected?.length) {
        return { assertion: "workspace_matches_expected", passed: false, detail: "missing spec.expected" };
      }
      for (const file of input.expected) {
        const path = join(input.work, file.path);
        const present = await exists(path);
        if (file.absent) {
          if (present) return { assertion: "workspace_matches_expected", passed: false, detail: `${file.path} should be absent` };
          continue;
        }
        if (!present) return { assertion: "workspace_matches_expected", passed: false, detail: `${file.path} missing` };
        if (file.contains) {
          const text = await readFile(path, "utf8");
          if (!text.includes(file.contains)) {
            return { assertion: "workspace_matches_expected", passed: false, detail: `${file.path} missing ${file.contains}` };
          }
        }
      }
      return { assertion: "workspace_matches_expected", passed: true };
    }
    case "application_eventually_responsive": {
      // CLI black-box approximation: the run did not hang, and when a recoverable
      // fault completed mid-run, the agent either kept producing output or still
      // finished cleanly. "Recovered the fault, then died silently" fails here.
      const base = !input.timedOut && input.code !== null;
      if (!base) {
        return {
          assertion: assertion.type,
          passed: false,
          detail: input.timedOut ? "timed out" : `exit ${input.code}`,
        };
      }
      if (input.lastRecoveryInLoopMs == null) {
        return { assertion: assertion.type, passed: true, detail: `exit ${input.code}` };
      }
      const responsive = Boolean(input.outputAfterRecovery) || input.code === 0;
      return {
        assertion: assertion.type,
        passed: responsive,
        detail: responsive
          ? `exit ${input.code}${input.outputAfterRecovery ? " + activity after fault recovery" : ""}`
          : "no agent activity after the last fault recovery",
      };
    }
    case "event_seen": {
      const seen = input.nativeEvents ?? [];
      return {
        assertion: `event_seen:${assertion.event}`,
        passed: seen.includes(assertion.event),
        detail: seen.join(",") || "none",
      };
    }
    case "no_lost_tool_result":
      return {
        assertion: "no_lost_tool_result",
        passed: (input.lostToolResults ?? 0) === 0,
        detail: String(input.lostToolResults ?? 0),
      };
    case "git_worktree_clean": {
      const wt = await gitWorktrees(input.work);
      const clean = wt.ok && wt.count <= 1 && !wt.locked;
      return {
        assertion: "git_worktree_clean",
        passed: clean,
        detail: wt.ok ? `worktrees: ${wt.count}, locked: ${wt.locked}` : "git worktree check failed",
      };
    }
    case "mcp_stdio_exactly_once": {
      if (!input.mcpJournal) {
        return { assertion: "mcp_stdio_exactly_once", passed: false, detail: "MCP stdio journal unavailable" };
      }
      try {
        const lines = (await readFile(input.mcpJournal, "utf8")).split("\n").filter(Boolean);
        const requests = new Map<string, number>();
        const responses = new Map<string, number>();
        for (const line of lines) {
          const record = JSON.parse(line) as { type?: string; key?: string };
          if (!record.key) continue;
          const target = record.type === "response" ? responses : requests;
          target.set(record.key, (target.get(record.key) ?? 0) + 1);
        }
        const failures = [...requests.entries()].filter(([key, count]) => count !== 1 || responses.get(key) !== 1);
        const duplicateResponses = [...responses.entries()].filter(([key, count]) => count !== 1 || !requests.has(key));
        const passed = requests.size > 0 && failures.length === 0 && duplicateResponses.length === 0;
        return {
          assertion: "mcp_stdio_exactly_once",
          passed,
          detail: JSON.stringify({ requests: requests.size, failures, duplicateResponses }),
        };
      } catch (err) {
        return { assertion: "mcp_stdio_exactly_once", passed: false, detail: `journal error: ${String(err)}` };
      }
    }
    case "mcp_stdio_resume_consistent": {
      if (!input.mcpJournal) {
        return { assertion: "mcp_stdio_resume_consistent", passed: false, detail: "MCP stdio journal unavailable" };
      }
      try {
        const lines = (await readFile(input.mcpJournal, "utf8")).split("\n").filter(Boolean);
        const requests = new Map<string, number>();
        const responses = new Map<string, number>();
        const replays = new Map<string, number>();
        for (const line of lines) {
          const record = JSON.parse(line) as { type?: string; dedupeKey?: string; key?: string };
          const key = record.dedupeKey ?? record.key;
          if (!key) continue;
          if (record.type === "request") requests.set(key, (requests.get(key) ?? 0) + 1);
          else if (record.type === "response") responses.set(key, (responses.get(key) ?? 0) + 1);
          else if (record.type === "response_replay") replays.set(key, (replays.get(key) ?? 0) + 1);
        }
        const failures = [...requests.entries()]
          .filter(([key, count]) => count < 2 || responses.get(key) !== 1 || (replays.get(key) ?? 0) < 1)
          .map(([key, count]) => ({ key, requests: count, responses: responses.get(key) ?? 0, replays: replays.get(key) ?? 0 }));
        return {
          assertion: "mcp_stdio_resume_consistent",
          passed: requests.size > 0 && failures.length === 0,
          detail: JSON.stringify({ requests: requests.size, failures }),
        };
      } catch (err) {
        return { assertion: "mcp_stdio_resume_consistent", passed: false, detail: `journal error: ${String(err)}` };
      }
    }
    case "subagent_exactly_once": {
      if (!input.subagentJournal) {
        return { assertion: "subagent_exactly_once", passed: false, detail: "subagent journal unavailable" };
      }
      try {
        const lines = (await readFile(input.subagentJournal, "utf8")).split("\n").filter(Boolean);
        const started = new Map<string, number>();
        const terminal = new Map<string, number>();
        const invalid: string[] = [];
        for (const line of lines) {
          const record = JSON.parse(line) as { type?: string; id?: string };
          if (!record.id) {
            invalid.push("missing-id");
            continue;
          }
          if (record.type === "started") started.set(record.id, (started.get(record.id) ?? 0) + 1);
          if (record.type === "finished" || record.type === "killed") {
            terminal.set(record.id, (terminal.get(record.id) ?? 0) + 1);
          }
        }
        const failures = [...started.entries()].filter(([id, count]) => count !== 1 || terminal.get(id) !== 1);
        const terminalWithoutStart = [...terminal.keys()].filter((id) => !started.has(id));
        const passed = started.size > 0 && invalid.length === 0 && failures.length === 0 && terminalWithoutStart.length === 0;
        return {
          assertion: "subagent_exactly_once",
          passed,
          detail: JSON.stringify({ started: started.size, failures, terminalWithoutStart, invalid }),
        };
      } catch (err) {
        return { assertion: "subagent_exactly_once", passed: false, detail: `journal error: ${String(err)}` };
      }
    }
    case "subagent_resume_consistent": {
      if (!input.subagentJournal) {
        return { assertion: "subagent_resume_consistent", passed: false, detail: "subagent journal unavailable" };
      }
      try {
        const lines = (await readFile(input.subagentJournal, "utf8")).split("\n").filter(Boolean);
        const starts = new Map<string, { generation: number; sessionId?: string }[]>();
        const terminals = new Map<string, { generation: number; sessionId?: string }[]>();
        const restarts: unknown[] = [];
        const invalid: string[] = [];
        for (const line of lines) {
          const record = JSON.parse(line) as {
            type?: string;
            id?: string;
            generation?: number;
            sessionId?: string;
          };
          if (record.type === "restart") {
            restarts.push(record);
            continue;
          }
          if (!record.id || !Number.isInteger(record.generation)) {
            invalid.push("missing-id-or-generation");
            continue;
          }
          const item = { generation: record.generation, sessionId: record.sessionId };
          if (record.type === "started") {
            const values = starts.get(record.id) ?? [];
            values.push(item);
            starts.set(record.id, values);
          } else if (record.type === "finished" || record.type === "killed") {
            const values = terminals.get(record.id) ?? [];
            values.push(item);
            terminals.set(record.id, values);
          } else if (record.type !== "checkpoint") {
            invalid.push(`unknown:${record.type ?? "missing-type"}`);
          }
        }
        const failures: string[] = [];
        for (const [id, values] of starts) {
          const sessions = new Set(values.map((value) => value.sessionId).filter(Boolean));
          const end = terminals.get(id) ?? [];
          if (values.length < 2) failures.push(`${id}:not-resumed`);
          if (sessions.size > 1) failures.push(`${id}:session-drift`);
          if (end.length !== 1) failures.push(`${id}:terminal-count=${end.length}`);
          if (end.length === 1 && end[0].generation < values[values.length - 1].generation) {
            failures.push(`${id}:terminal-before-latest-start`);
          }
        }
        const terminalWithoutStart = [...terminals.keys()].filter((id) => !starts.has(id));
        const passed =
          starts.size > 0 &&
          restarts.length > 0 &&
          invalid.length === 0 &&
          failures.length === 0 &&
          terminalWithoutStart.length === 0;
        return {
          assertion: "subagent_resume_consistent",
          passed,
          detail: JSON.stringify({
            subagents: starts.size,
            restarts: restarts.length,
            failures,
            terminalWithoutStart,
            invalid,
          }),
        };
      } catch (err) {
        return { assertion: "subagent_resume_consistent", passed: false, detail: `journal error: ${String(err)}` };
      }
    }
    case "mcp_stdio_upstream_consistent": {
      if (!input.mcpJournal) {
        return { assertion: "mcp_stdio_upstream_consistent", passed: false, detail: "mcp journal unavailable" };
      }
      try {
        const lines = (await readFile(input.mcpJournal, "utf8")).split("\n").filter(Boolean);
        const forwards = new Map<string, number>();
        const responses = new Map<string, number>();
        for (const line of lines) {
          const rec = JSON.parse(line);
          if (rec.type === "upstream_forward" && rec.dedupeKey) {
            forwards.set(rec.dedupeKey, (forwards.get(rec.dedupeKey) ?? 0) + 1);
          }
          if (rec.type === "upstream_response" && rec.dedupeKey) {
            responses.set(rec.dedupeKey, (responses.get(rec.dedupeKey) ?? 0) + 1);
          }
        }
        const duplicates = [...forwards.entries()].filter(([, count]) => count > 1);
        const passed = duplicates.length === 0;
        return {
          assertion: "mcp_stdio_upstream_consistent",
          passed,
          detail: JSON.stringify({ forwards: forwards.size, responses: responses.size, duplicates }),
        };
      } catch (err) {
        return { assertion: "mcp_stdio_upstream_consistent", passed: false, detail: `journal error: ${String(err)}` };
      }
    }
    case "subagent_checkpoint_restored": {
      if (!input.subagentJournal) {
        return { assertion: "subagent_checkpoint_restored", passed: false, detail: "subagent journal unavailable" };
      }
      try {
        const lines = (await readFile(input.subagentJournal, "utf8")).split("\n").filter(Boolean);
        let hasCheckpoint = false;
        let hasRestoredOrFinished = false;
        for (const line of lines) {
          const rec = JSON.parse(line);
          if (rec.type === "checkpoint") hasCheckpoint = true;
          if (rec.type === "finished" || rec.type === "checkpoint_restored") hasRestoredOrFinished = true;
        }
        const passed = hasCheckpoint && hasRestoredOrFinished;
        return {
          assertion: "subagent_checkpoint_restored",
          passed,
          detail: JSON.stringify({ hasCheckpoint, hasRestoredOrFinished }),
        };
      } catch (err) {
        return { assertion: "subagent_checkpoint_restored", passed: false, detail: `journal error: ${String(err)}` };
      }
    }
    case "session_clean_recovery": {
      const passed = Boolean(input.sessionId) && input.code === 0;
      return {
        assertion: "session_clean_recovery",
        passed,
        detail: JSON.stringify({ sessionId: input.sessionId, exitCode: input.code }),
      };
    }
    case "desktop_screenshot_captured": {
      const candidates = [];
      if (assertion.path) {
        if (input.runRoot) candidates.push(join(input.runRoot, assertion.path));
        candidates.push(join(input.work, assertion.path));
      } else if (input.runRoot) {
        candidates.push(join(input.runRoot, "desktop-screenshot.png"));
      }
      let passed = false;
      let matchedPath: string | undefined;
      let size = 0;
      for (const p of candidates) {
        try {
          const s = await stat(p);
          if (s.size > 0) {
            passed = true;
            matchedPath = p;
            size = s.size;
            break;
          }
        } catch {}
      }
      if (!passed && input.runRoot) {
        try {
          const files = await readdir(input.runRoot);
          const found = files.find((f) => f.includes("screenshot") && f.endsWith(".png"));
          if (found) {
            const p = join(input.runRoot, found);
            const s = await stat(p);
            if (s.size > 0) {
              passed = true;
              matchedPath = p;
              size = s.size;
            }
          }
        } catch {}
      }
      return {
        assertion: "desktop_screenshot_captured",
        passed,
        detail: JSON.stringify({ targetPath: matchedPath ?? candidates[0], size }),
      };
    }
    case "desktop_unresponsive_detected": {
      const passed = input.injected.some((i) => i.includes("desktop.freeze") || i.includes("desktop.close_window"));
      return {
        assertion: "desktop_unresponsive_detected",
        passed,
        detail: JSON.stringify({ injected: input.injected }),
      };
    }
    case "resource_exhaustion_recovered": {
      let passed = false;
      const testFile = join(input.work, `.agentchaos-probe-${Date.now()}.tmp`);
      try {
        await writeFile(testFile, "probe-ok\n");
        const readBack = await readFile(testFile, "utf8");
        await rm(testFile, { force: true });
        passed = readBack.trim() === "probe-ok";
      } catch {}
      return {
        assertion: "resource_exhaustion_recovered",
        passed,
        detail: JSON.stringify({ probeVerified: passed }),
      };
    }
    case "remote_lease_valid": {
      if (!input.remoteCoordinator) {
        return { assertion: "remote_lease_valid", passed: false, detail: "remote coordinator unavailable" };
      }
      const leases = input.remoteCoordinator.getLeases();
      const passed = leases.length > 0 && leases.some((l) => l.heartbeats > 0);
      return {
        assertion: "remote_lease_valid",
        passed,
        detail: JSON.stringify({ leases: leases.length, active: input.remoteCoordinator.getHealthyLeases().length }),
      };
    }
    case "remote_reconnect_success": {
      if (!input.remoteCoordinator) {
        return { assertion: "remote_reconnect_success", passed: false, detail: "remote coordinator unavailable" };
      }
      const leases = input.remoteCoordinator.getLeases();
      const passed = leases.length > 0 && (leases.length > 1 || leases.some((l) => l.heartbeats >= 2));
      return {
        assertion: "remote_reconnect_success",
        passed,
        detail: JSON.stringify({ leasesCount: leases.length }),
      };
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
