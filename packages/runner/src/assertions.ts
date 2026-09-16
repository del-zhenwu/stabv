import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Assertion, ExpectedFile, VerifySpec } from "./spec.ts";
import type { HelperTree } from "./helper.ts";
import { gitPorcelain, runVerify } from "./observe.ts";

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
