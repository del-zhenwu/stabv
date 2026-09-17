import { parse as parseYaml } from "yaml";
import { parseDuration } from "./duration.ts";
import {
  LLM_FAULT_ACTIONS,
  LLM_FIELDS,
  LLM_SCHEDULES,
  defaultFieldForScene,
  resolveLlmScene,
  type LlmFaultAction,
  type LlmField,
  type LlmSchedule,
} from "./llm-api.ts";
import { isNativeEventKind, type NativeEventKind } from "./native-events.ts";
import { faultLineNumbers, faultPrefix, type SourceLoc } from "./yaml-loc.ts";
import { parseInject } from "./inject.ts";

export type AdapterName =
  | "codex"
  | "claude"
  | "kimi"
  | "zcode"
  | "opencode"
  | "cursor"
  | "zed"
  | "generic-cli";

export type ProcessFault = {
  kind: "process";
  action: "kill" | "pause" | "restart";
  atMs: number;
  durationMs?: number;
  target?: string;
};

export type FileFault = {
  kind: "file";
  action: "edit" | "delete" | "rename" | "chmod" | "symlink" | "lock";
  atMs: number;
  durationMs?: number;
  path: string;
  content?: string;
  sizeBytes?: number;
  to?: string;
  mode?: string;
  linkTarget?: string;
};

export type GitFault = {
  kind: "git";
  action: "lock" | "conflict" | "switch-branch" | "worktree-leak" | "worktree-lock";
  atMs: number;
  durationMs?: number;
  path?: string;
  branch?: string;
  content?: string;
};

export type NetworkFault = {
  kind: "network";
  action: "delay" | "timeout" | "reset";
  atMs: number;
  durationMs?: number;
  delayMs?: number;
};

export type LlmFault = {
  kind: "llm";
  action: LlmFaultAction;
  atMs: number;
  durationMs?: number;
  delayMs?: number;
  field?: LlmField;
  schedule?: LlmSchedule;
  probability?: number;
  burst?: number;
  callIndex?: number;
  seed?: number;
  scene?: string;
};

export type ResourceFault = {
  kind: "resource";
  action: "cpu" | "memory" | "port" | "disk" | "handle_exhaustion" | "disk_exhaustion";
  atMs: number;
  durationMs?: number;
  threads?: number;
  mb?: number;
  port?: number;
  path?: string;
  limit?: number;
};

export type InputFault = {
  kind: "input";
  action: "send" | "eof" | "encoding" | "block";
  atMs: number;
  durationMs?: number;
  text?: string;
  encoding?: "utf8" | "latin1" | "base64";
};

export type CancelFault = {
  kind: "cancel";
  action: "interrupt" | "double" | "late";
  atMs: number;
  durationMs?: number;
};

export type HookFault = {
  kind: "hook";
  action: "fail" | "overwrite" | "block";
  atMs: number;
  durationMs?: number;
  path: string;
  content?: string;
};

export type StdoutFault = {
  kind: "stdout";
  action: "huge";
  atMs: number;
  durationMs?: number;
  bytes?: number;
  chunkBytes?: number;
};

export type McpFault = {
  kind: "mcp";
  action:
    | "delay"
    | "timeout"
    | "429"
    | "500"
    | "malformed"
    | "truncate"
    | "schema_drift"
    | "duplicate"
    | "oversized"
    | "crash"
    | "partial_write"
    | "chunked";
  transport?: "http" | "stdio";
  atMs: number;
  durationMs?: number;
  delayMs?: number;
};

export type ApprovalFault = {
  kind: "approval";
  action: "deny" | "drop" | "delay";
  atMs: number;
  durationMs?: number;
  text?: string;
};

export type CompactionFault = {
  kind: "compaction";
  action: "interrupt" | "drift";
  atMs: number;
  durationMs?: number;
};

export type SubagentFault = {
  kind: "subagent";
  action: "kill" | "timeout" | "fail" | "conflict" | "checkpoint";
  atMs: number;
  durationMs?: number;
  target?: string;
  path?: string;
  checkpointId?: string;
};

export type SessionFault = {
  kind: "session";
  action: "corrupt" | "truncate" | "lock" | "schema_drift" | "migration";
  atMs: number;
  durationMs?: number;
  path: string;
};

export type DesktopFault = {
  kind: "desktop";
  action: "close_window" | "send_text" | "screenshot" | "freeze";
  atMs: number;
  durationMs?: number;
  text?: string;
  path?: string;
};

export type RemoteFault = {
  kind: "remote";
  action: "disconnect" | "heartbeat_timeout" | "lease_expire";
  atMs: number;
  durationMs?: number;
};

export type RuleFault = {
  kind: "rule";
  action: "evict" | "conflict" | "corrupt";
  atMs: number;
  durationMs?: number;
  pattern?: string;
  ruleText?: string;
};

export type ContextFault = {
  kind: "context";
  action: "poison" | "truncate" | "reorder";
  atMs: number;
  durationMs?: number;
  poisonMessage?: { role: string; content: string };
};

export type Fault = (
  | ProcessFault
  | FileFault
  | GitFault
  | NetworkFault
  | LlmFault
  | ResourceFault
  | InputFault
  | CancelFault
  | HookFault
  | StdoutFault
  | McpFault
  | ApprovalFault
  | CompactionFault
  | SubagentFault
  | SessionFault
  | DesktopFault
  | RemoteFault
  | RuleFault
  | ContextFault
) & {
  loc?: SourceLoc;
  /** Inject after this native event instead of (or in addition to delaying from) wall-clock `at`. */
  when?: NativeEventKind;
};

export type Assertion =
  | { type: "exit_zero" }
  | { type: "exit_nonzero" }
  | { type: "timed_out" }
  | { type: "not_timed_out" }
  | { type: "file_exists"; path: string }
  | { type: "file_absent"; path: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "output_contains"; text: string }
  | { type: "no_orphan_process" }
  | { type: "fault_injected"; fault: string }
  | { type: "llm_triggered" }
  | { type: "git_lock_absent" }
  | { type: "task_tests_pass" }
  | { type: "git_state_consistent" }
  | { type: "no_duplicate_tool_side_effect" }
  | { type: "session_resumable" }
  | { type: "workspace_matches_expected" }
  | { type: "application_eventually_responsive" }
  | { type: "event_seen"; event: string }
  | { type: "no_lost_tool_result" }
  | { type: "git_worktree_clean" }
  | { type: "mcp_stdio_exactly_once" }
  | { type: "mcp_stdio_resume_consistent" }
  | { type: "mcp_stdio_upstream_consistent" }
  | { type: "subagent_exactly_once" }
  | { type: "subagent_resume_consistent" }
  | { type: "subagent_checkpoint_restored" }
  | { type: "session_clean_recovery" }
  | { type: "desktop_screenshot_captured"; path?: string }
  | { type: "desktop_unresponsive_detected" }
  | { type: "resource_exhaustion_recovered" }
  | { type: "remote_lease_valid" }
  | { type: "remote_reconnect_success" };

export type ExpectedFile = {
  path: string;
  contains?: string;
  absent?: boolean;
};

export type EvidenceProvenance = "empirical" | "static_probe" | "agent_inference";

export type InvariantViolation = {
  invariant: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  summary: string;
  provenance: EvidenceProvenance;
  causalChain?: { step: number; event: string; atMs?: number; detail?: Record<string, unknown> }[];
  suspectedCodeSite?: { file?: string; symbol?: string; reason?: string };
  reproductionSpec?: string;
  reproductionCommand?: string;
  suggestedFixPattern?: { strategy: string; description: string };
};

export type DiagnosisReport = {
  schemaVersion: string;
  runId: string;
  experimentName: string;
  target: { adapter: string; executable?: string; version?: string };
  verdict: "PASSED" | "FAILED" | "INCONCLUSIVE";
  invariantsViolated: InvariantViolation[];
  evidenceSummary: {
    empiricalCount: number;
    staticCount: number;
    inferredCount: number;
  };
  metrics: Record<string, unknown>;
  reproductionSpecSnippet?: string;
};

export type Perturbation = {
  type: "prompt_noise" | "prompt_prefix" | "prompt_suffix";
  text: string;
};

export type TargetSpec = {
  adapter: AdapterName;
  command?: string;
  executable?: string;
  args?: string[];
  env?: Record<string, string>;
  prompt?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  extraArgs?: string[];
  ephemeral?: boolean;
  json?: boolean;
  bypassApprovals?: boolean;
  pty?: boolean;
  sessionHome?: string;
  desktop?: boolean;
};

export type VerifySpec = {
  executable: string;
  args: string[];
};

export type ExperimentMode = "rules" | "auto";

export type Experiment = {
  apiVersion: string;
  kind: string;
  name: string;
  target: TargetSpec;
  workspaceDir: string;
  isolate: boolean;
  fixture?: string;
  git: boolean;
  timeoutMs: number;
  faults: Fault[];
  mode: ExperimentMode;
  budget?: number;
  llm?: { model?: string };
  ioStallTimeoutMs?: number;
  retryStormThreshold?: number;
  retryStormWindowMs?: number;
  recovery: { restart: boolean; resume: boolean };
  assertions: Assertion[];
  /** True when YAML omitted assertions; runner may add checks for faults injected at runtime. */
  assertionsDefaulted?: boolean;
  verify?: VerifySpec;
  expected?: ExpectedFile[];
  perturbations?: Perturbation[];
  /** Who is under test, for reports. */
  agent?: string;
  /** User-facing inject tokens (llm, resource, llm/429). */
  inject?: string[];
  together?: boolean;
  sourcePath?: string;
  raw: unknown;
};

export type Suite = {
  apiVersion: string;
  kind: "Suite";
  name: string;
  repeat: number;
  experiments: string[];
  workloads?: string[];
  profiles?: string[];
  agent?: string;
  inject?: string[];
  /** User fields from a one-file inject spec, applied on top of catalog workloads. */
  overlay?: Record<string, unknown>;
  sourcePath?: string;
};

export type WorkflowTask = {
  type: "serial" | "parallel";
  experiments: string[];
};

export type Workflow = {
  apiVersion: string;
  kind: "Workflow";
  name: string;
  tasks: WorkflowTask[];
  failFast: boolean;
  sourcePath?: string;
};

export type ParseCtx = {
  sourcePath?: string;
  faultLines?: (number | undefined)[];
};

export function loadSpecText(text: string, sourceName: string): Experiment {
  const raw = sourceName.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return normalizeSpec(raw, {
    sourcePath: sourceName,
    faultLines: sourceName.endsWith(".json") ? [] : faultLineNumbers(text),
  });
}

export function normalizeSpec(raw: any, ctx: ParseCtx = {}): Experiment {
  if (!raw || typeof raw !== "object") throw new Error("experiment spec must be an object");
  const spec = raw.spec && typeof raw.spec === "object" ? { ...raw, ...raw.spec, metadata: raw.metadata } : raw;
  const metadata = raw.metadata ?? {};
  const targetIn = spec.target ?? {};
  const target = normalizeTarget(targetIn);
  const faults = (spec.faults ?? []).map((fault: unknown, i: number) =>
    withLoc(
      normalizeFault(fault, i, { file: ctx.sourcePath, line: ctx.faultLines?.[i] }),
      { file: ctx.sourcePath, line: ctx.faultLines?.[i] },
    ),
  );
  faults.sort((a: Fault, b: Fault) => a.atMs - b.atMs);
  const workspace = spec.workspace;
  const workspaceDir =
    typeof workspace === "string"
      ? workspace
      : (workspace?.root ?? spec.workspaceDir ?? ".agentchaos-runs");
  const git =
    typeof spec.git === "boolean"
      ? spec.git
      : typeof workspace === "object" && workspace?.git != null
        ? Boolean(workspace.git)
        : target.adapter === "codex" ||
            target.adapter === "zcode" ||
            target.adapter === "claude" ||
            target.adapter === "kimi" ||
            (spec.faults ?? []).some((f: any) => f?.type === "git" || f?.kind === "git");
  const recovery = {
    restart: Boolean(spec.recovery?.restart),
    resume: Boolean(spec.recovery?.resume),
  };
  const verify = normalizeVerify(spec.verify ?? spec.grader ?? spec.workload?.verify);
  const expected = normalizeExpected(spec.expected ?? spec.workload?.expected);
  const mode: ExperimentMode = spec.mode === "auto" ? "auto" : "rules";
  const assertionsOmitted = !((spec.assertions as unknown[] | undefined)?.length);
  const assertions = (assertionsOmitted
    ? defaultAssertionNames({
        git,
        mode,
        faults,
        recovery,
        verify,
        expected,
        ephemeral: target.ephemeral,
      })
    : (spec.assertions as unknown[])
  ).map((a: unknown, i: number) => normalizeAssertion(a, i));
  return {
    apiVersion: raw.apiVersion ?? "agentchaos.dev/v1alpha1",
    kind: raw.kind ?? "Experiment",
    name: metadata.name ?? spec.name ?? "unnamed",
    target,
    workspaceDir,
    isolate: workspace?.isolate !== false,
    fixture: spec.workload?.fixture ?? spec.fixture,
    git,
    timeoutMs: spec.timeout != null ? parseDuration(spec.timeout, "timeout") : 180_000,
    faults,
    mode,
    budget: typeof spec.budget === "number" ? Math.max(1, spec.budget) : undefined,
    llm: spec.llm && typeof spec.llm === "object" ? { model: spec.llm.model != null ? String(spec.llm.model) : undefined } : undefined,
    ioStallTimeoutMs:
      spec.ioStallTimeout != null
        ? parseDuration(spec.ioStallTimeout, "ioStallTimeout")
        : (spec.ioStallTimeoutMs ??
          (spec.watchdog?.stallTimeout ? parseDuration(spec.watchdog.stallTimeout, "watchdog.stallTimeout") : undefined)),
    retryStormThreshold:
      spec.retryStormThreshold ??
      spec.watchdog?.retryStormThreshold ??
      spec.watchdog?.churnThreshold,
    retryStormWindowMs:
      spec.retryStormWindow != null
        ? parseDuration(spec.retryStormWindow, "retryStormWindow")
        : (spec.watchdog?.window ? parseDuration(spec.watchdog.window, "watchdog.window") : 3000),
    recovery,
    assertions,
    assertionsDefaulted: assertionsOmitted,
    verify,
    expected,
    perturbations: normalizePerturbations(spec.perturbations ?? spec.profile?.perturbations),
    agent: spec.agent != null ? String(spec.agent) : target.adapter,
    inject: parseInject(spec.inject, spec.together)?.tokens,
    together: parseInject(spec.inject, spec.together)?.together,
    raw,
  };
}

function normalizeTarget(input: any): TargetSpec {
  const adapter = (input.adapter ?? (input.executable || input.command ? "generic-cli" : "codex")) as AdapterName;
  return {
    adapter,
    command: input.command,
    executable: input.executable,
    args: input.args,
    env: input.env,
    prompt: input.prompt,
    sandbox: input.sandbox,
    extraArgs: input.extraArgs ?? input.extra_args,
    ephemeral: input.ephemeral,
    json: input.json,
    bypassApprovals: input.bypassApprovals ?? input.fullAuto ?? input["full-auto"],
    pty: Boolean(input.pty),
    sessionHome: input.sessionHome ?? input.session_home,
    desktop: Boolean(input.desktop),
  };
}

function normalizeVerify(input: any): VerifySpec | undefined {
  if (!input) return undefined;
  if (typeof input === "string") {
    return process.platform === "win32"
      ? { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", input] }
      : { executable: "/bin/sh", args: ["-lc", input] };
  }
  if (input.executable) return { executable: input.executable, args: input.args ?? [] };
  if (input.command) return normalizeVerify(input.command);
  return undefined;
}

function withLoc<T extends Fault>(fault: T, loc?: SourceLoc): T {
  if (loc?.file || loc?.line != null) fault.loc = loc;
  return fault;
}

function finishFault<T extends Fault>(fault: T, input: any, index: number, loc?: SourceLoc): T {
  if (input.when != null && input.when !== "") {
    const when = String(input.when);
    if (!isNativeEventKind(when)) {
      throw new Error(`${faultPrefix(index, loc)} unknown when ${when}`);
    }
    fault.when = when;
  }
  return withLoc(fault, loc);
}

function normalizeFault(input: any, index: number, loc?: SourceLoc): Fault {
  const at = (msg: string) => `${faultPrefix(index, loc)} ${msg}`;
  if (!input || typeof input !== "object") throw new Error(at("must be an object"));
  const atMs = parseDuration(input.at ?? 0, `${faultPrefix(index, loc)}.at`);
  const durationMs = input.duration != null ? parseDuration(input.duration, `${faultPrefix(index, loc)}.duration`) : undefined;
  const type = String(input.type ?? input.kind ?? "");
  if (type === "process_kill") return finishFault({ kind: "process", action: "kill", atMs, target: input.target }, input, index, loc);
  if (type === "file_edit") {
    if (!input.path) throw new Error(at("file_edit requires path"));
    return finishFault({ kind: "file", action: "edit", atMs, path: input.path, content: input.content }, input, index, loc);
  }
  if (type === "network_delay") {
    return finishFault({ kind: "network", action: "delay", atMs, durationMs, delayMs: durationMs }, input, index, loc);
  }
  if (type === "process") {
    const action = input.action ?? "kill";
    if (!["kill", "pause", "restart"].includes(action)) {
      throw new Error(at(`unknown process action ${action}`));
    }
    return finishFault({ kind: "process", action, atMs, durationMs, target: input.target }, input, index, loc);
  }
  if (type === "file") {
    const action = input.action ?? "edit";
    if (!["edit", "delete", "rename", "chmod", "symlink", "lock"].includes(action)) {
      throw new Error(at(`unknown file action ${action}`));
    }
    if (!input.path) throw new Error(at("file fault requires path"));
    return finishFault({
      kind: "file",
      action,
      atMs,
      durationMs,
      path: input.path,
      content: input.content,
      sizeBytes: input.sizeBytes != null ? Number(input.sizeBytes) : input.size != null ? Number(input.size) : undefined,
      to: input.to,
      mode: input.mode != null ? String(input.mode) : undefined,
      linkTarget: input.target ?? input.linkTarget,
    }, input, index, loc);
  }
  if (type === "git") {
    const action = input.action ?? "lock";
    if (!["lock", "conflict", "switch-branch", "worktree-leak", "worktree-lock"].includes(action)) {
      throw new Error(at(`unknown git action ${action}`));
    }
    return finishFault({ kind: "git", action, atMs, durationMs, path: input.path, branch: input.branch, content: input.content }, input, index, loc);
  }
  if (type === "network") {
    const action = input.action ?? "delay";
    if (!["delay", "timeout", "reset"].includes(action)) {
      throw new Error(at(`unknown network action ${action}`));
    }
    const delayMs =
      input.delayMs != null
        ? parseDuration(input.delayMs, `${faultPrefix(index, loc)}.delayMs`)
        : input.delay != null
          ? parseDuration(input.delay, `${faultPrefix(index, loc)}.delay`)
          : durationMs;
    return finishFault({ kind: "network", action, atMs, durationMs, delayMs }, input, index, loc);
  }
  if (type === "llm") {
    const action = resolveLlmScene(input.scene != null ? String(input.scene) : undefined, input.action != null ? String(input.action) : undefined);
    if (!(LLM_FAULT_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(at(`unknown llm action ${action}`));
    }
    const delayMs =
      input.delayMs != null
        ? parseDuration(input.delayMs, `${faultPrefix(index, loc)}.delayMs`)
        : input.delay != null
          ? parseDuration(input.delay, `${faultPrefix(index, loc)}.delay`)
          : durationMs;
    const fieldRaw = input.field != null ? String(input.field) : defaultFieldForScene(input.scene != null ? String(input.scene) : undefined);
    if (fieldRaw != null && !(LLM_FIELDS as readonly string[]).includes(fieldRaw)) {
      throw new Error(at(`unknown llm field ${fieldRaw}`));
    }
    const schedule = input.schedule != null ? String(input.schedule) : undefined;
    if (schedule != null && !(LLM_SCHEDULES as readonly string[]).includes(schedule)) {
      throw new Error(at(`unknown llm schedule ${schedule}`));
    }
    const probability = input.probability != null ? Number(input.probability) : input.p != null ? Number(input.p) : undefined;
    if (probability != null && !(probability >= 0 && probability <= 1)) {
      throw new Error(at("llm probability must be between 0 and 1"));
    }
    const burst = input.burst != null ? Number(input.burst) : undefined;
    if (burst != null && !(burst >= 1)) {
      throw new Error(at("llm burst must be >= 1"));
    }
    const callIndex = input.callIndex != null ? Number(input.callIndex) : input.position != null ? Number(input.position) : undefined;
    if (callIndex != null && !(callIndex >= 1)) {
      throw new Error(at("llm callIndex must be >= 1"));
    }
    const seed = input.seed != null ? Number(input.seed) : undefined;
    return finishFault(
      {
        kind: "llm",
        action: action as LlmFaultAction,
        atMs,
        durationMs,
        delayMs,
        field: fieldRaw as LlmField | undefined,
        schedule: schedule as LlmSchedule | undefined,
        probability,
        burst,
        callIndex,
        seed,
        scene: input.scene != null ? String(input.scene) : undefined,
      },
      input,
      index,
      loc,
    );
  }
  if (type === "mcp") {
    const action = String(input.action ?? "timeout");
    if (!["delay", "timeout", "429", "500", "malformed", "truncate", "schema_drift", "duplicate", "oversized", "crash", "partial_write", "chunked"].includes(action)) {
      throw new Error(at(`unknown mcp action ${action}`));
    }
    const delayMs =
      input.delayMs != null
        ? parseDuration(input.delayMs, `${faultPrefix(index, loc)}.delayMs`)
        : input.delay != null
          ? parseDuration(input.delay, `${faultPrefix(index, loc)}.delay`)
          : durationMs;
    const transport = input.transport === "stdio" ? "stdio" : input.transport === "http" ? "http" : undefined;
    return finishFault({ kind: "mcp", action: action as McpFault["action"], transport, atMs, durationMs, delayMs }, input, index, loc);
  }
  if (type === "resource") {
    const action = input.action ?? "cpu";
    if (!["cpu", "memory", "port", "disk", "handle_exhaustion", "disk_exhaustion"].includes(action)) {
      throw new Error(at(`unknown resource action ${action}`));
    }
    return finishFault({
      kind: "resource",
      action,
      atMs,
      durationMs,
      threads: input.threads,
      mb: input.mb,
      port: input.port != null ? Number(input.port) : undefined,
      path: input.path != null ? String(input.path) : undefined,
      limit: input.limit != null ? Number(input.limit) : undefined,
    }, input, index, loc);
  }
  if (type === "input") {
    const action = input.action ?? "send";
    if (!["send", "eof", "encoding", "block"].includes(action)) {
      throw new Error(at(`unknown input action ${action}`));
    }
    if ((action === "send" || action === "encoding") && input.text == null) throw new Error(at(`input.${action} requires text`));
    const encoding = input.encoding == null ? "utf8" : String(input.encoding);
    if (!["utf8", "latin1", "base64"].includes(encoding)) throw new Error(at(`unknown input encoding ${encoding}`));
    return finishFault({ kind: "input", action, atMs, durationMs, text: input.text != null ? String(input.text) : undefined, encoding: encoding as InputFault["encoding"] }, input, index, loc);
  }
  if (type === "cancel") {
    const action = input.action ?? "interrupt";
    if (!["interrupt", "double", "late"].includes(action)) throw new Error(at(`unknown cancel action ${action}`));
    return finishFault({ kind: "cancel", action, atMs, durationMs }, input, index, loc);
  }
  if (type === "hook") {
    const action = input.action ?? "fail";
    if (!["fail", "overwrite", "block"].includes(action)) throw new Error(at(`unknown hook action ${action}`));
    if (!input.path) throw new Error(at("hook fault requires path"));
    return finishFault({ kind: "hook", action, atMs, durationMs, path: String(input.path), content: input.content != null ? String(input.content) : undefined }, input, index, loc);
  }
  if (type === "stdout") {
    const action = input.action ?? "huge";
    if (action !== "huge") throw new Error(at(`unknown stdout action ${action}`));
    return finishFault({ kind: "stdout", action: "huge", atMs, durationMs, bytes: input.bytes == null ? undefined : Number(input.bytes), chunkBytes: input.chunkBytes == null ? undefined : Number(input.chunkBytes) }, input, index, loc);
  }
  if (type === "approval") {
    const action = input.action ?? "deny";
    if (!["deny", "drop", "delay"].includes(action)) {
      throw new Error(at(`unknown approval action ${action}`));
    }
    const fault: ApprovalFault = {
      kind: "approval",
      action,
      atMs,
      durationMs,
      text: input.text != null ? String(input.text) : undefined,
    };
    const finished = finishFault(fault, input, index, loc);
    if (!finished.when) finished.when = "approval_requested";
    return finished;
  }
  if (type === "compaction") {
    const action = input.action ?? "interrupt";
    if (!["interrupt", "drift"].includes(action)) throw new Error(at(`unknown compaction action ${action}`));
    const finished = finishFault({ kind: "compaction", action: action as CompactionFault["action"], atMs, durationMs }, input, index, loc);
    if (!finished.when) finished.when = "compaction_started";
    return finished;
  }
  if (type === "subagent") {
    const action = input.action ?? "kill";
    if (!["kill", "timeout", "fail", "conflict", "checkpoint"].includes(action)) {
      throw new Error(at(`unknown subagent action ${action}`));
    }
    const fault: SubagentFault = {
      kind: "subagent",
      action,
      atMs,
      durationMs,
      target: input.target != null ? String(input.target) : undefined,
      path: input.path != null ? String(input.path) : undefined,
      checkpointId: input.checkpointId != null ? String(input.checkpointId) : undefined,
    };
    const finished = finishFault(fault, input, index, loc);
    if (!finished.when && input.at == null) finished.when = "subagent_started";
    return finished;
  }
  if (type === "session") {
    const action = input.action ?? "corrupt";
    if (!["corrupt", "truncate", "lock", "schema_drift", "migration"].includes(action)) {
      throw new Error(at(`unknown session action ${action}`));
    }
    if (!input.path) throw new Error(at("session fault requires path"));
    return finishFault(
      { kind: "session", action, atMs, durationMs, path: String(input.path) },
      input,
      index,
      loc,
    );
  }
  if (type === "desktop") {
    const action = input.action ?? "close_window";
    if (!["close_window", "send_text", "screenshot", "freeze"].includes(action)) throw new Error(at(`unknown desktop action ${action}`));
    if (action === "send_text" && input.text == null) throw new Error(at("desktop.send_text requires text"));
    return finishFault({
      kind: "desktop",
      action,
      atMs,
      durationMs,
      text: input.text == null ? undefined : String(input.text),
      path: input.path == null ? undefined : String(input.path),
    }, input, index, loc);
  }
  if (type === "remote") {
    const action = input.action ?? "disconnect";
    if (!["disconnect", "heartbeat_timeout", "lease_expire"].includes(action)) {
      throw new Error(at(`unknown remote action ${action}`));
    }
    return finishFault({ kind: "remote", action, atMs, durationMs }, input, index, loc);
  }
  if (type === "rule") {
    const action = input.action ?? "conflict";
    if (!["evict", "conflict", "corrupt"].includes(action)) {
      throw new Error(at(`unknown rule action ${action}`));
    }
    return finishFault(
      {
        kind: "rule",
        action,
        atMs,
        durationMs,
        pattern: input.pattern != null ? String(input.pattern) : undefined,
        ruleText: input.ruleText != null ? String(input.ruleText) : input.text != null ? String(input.text) : undefined,
      },
      input,
      index,
      loc,
    );
  }
  if (type === "context") {
    const action = input.action ?? "poison";
    if (!["poison", "truncate", "reorder"].includes(action)) {
      throw new Error(at(`unknown context action ${action}`));
    }
    return finishFault(
      {
        kind: "context",
        action,
        atMs,
        durationMs,
        poisonMessage: input.poisonMessage ?? input.message,
      },
      input,
      index,
      loc,
    );
  }
  throw new Error(at(`unknown type ${type}`));
}

function normalizeAssertion(input: unknown, index: number): Assertion {
  if (typeof input === "string") {
    if (input === "exit_zero") return { type: "exit_zero" };
    if (input === "exit_nonzero") return { type: "exit_nonzero" };
    if (input === "timed_out") return { type: "timed_out" };
    if (input === "not_timed_out") return { type: "not_timed_out" };
    if (input === "no_orphan_process") return { type: "no_orphan_process" };
    if (input === "git_lock_absent") return { type: "git_lock_absent" };
    if (input === "task_tests_pass") return { type: "task_tests_pass" };
    if (input === "git_state_consistent") return { type: "git_state_consistent" };
    if (input === "no_duplicate_tool_side_effect" || input === "no_duplicate_side_effect") {
      return { type: "no_duplicate_tool_side_effect" };
    }
    if (input === "session_resumable") return { type: "session_resumable" };
    if (input === "workspace_matches_expected") return { type: "workspace_matches_expected" };
    if (input === "application_eventually_responsive") return { type: "application_eventually_responsive" };
    if (input === "no_lost_tool_result" || input === "no_lost_tool_results") {
      return { type: "no_lost_tool_result" };
    }
    if (input === "git_worktree_clean" || input === "no_dangling_worktree") {
      return { type: "git_worktree_clean" };
    }
    if (input.startsWith("file_exists:")) return { type: "file_exists", path: input.slice("file_exists:".length) };
    if (input.startsWith("file_absent:")) return { type: "file_absent", path: input.slice("file_absent:".length) };
    if (input.startsWith("file_contains:")) {
      const rest = input.slice("file_contains:".length);
      const sep = rest.indexOf(":");
      if (sep < 0) throw new Error(`assertions[${index}] file_contains needs path:text`);
      return { type: "file_contains", path: rest.slice(0, sep), text: rest.slice(sep + 1) };
    }
    if (input.startsWith("output_contains:")) return { type: "output_contains", text: input.slice("output_contains:".length) };
    if (input.startsWith("fault_injected:")) return { type: "fault_injected", fault: input.slice("fault_injected:".length) };
    if (input === "llm_triggered") return { type: "llm_triggered" };
    if (input.startsWith("event_seen:")) return { type: "event_seen", event: input.slice("event_seen:".length) };
    if (input === "mcp_stdio_exactly_once") return { type: "mcp_stdio_exactly_once" };
    if (input === "mcp_stdio_resume_consistent") return { type: "mcp_stdio_resume_consistent" };
    if (input === "mcp_stdio_upstream_consistent") return { type: "mcp_stdio_upstream_consistent" };
    if (input === "subagent_exactly_once") return { type: "subagent_exactly_once" };
    if (input === "subagent_resume_consistent") return { type: "subagent_resume_consistent" };
    if (input === "subagent_checkpoint_restored") return { type: "subagent_checkpoint_restored" };
    if (input === "session_clean_recovery") return { type: "session_clean_recovery" };
    if (input === "desktop_screenshot_captured") return { type: "desktop_screenshot_captured" };
    if (input.startsWith("desktop_screenshot_captured:")) {
      return { type: "desktop_screenshot_captured", path: input.slice("desktop_screenshot_captured:".length) };
    }
    if (input === "desktop_unresponsive_detected") return { type: "desktop_unresponsive_detected" };
    if (input === "resource_exhaustion_recovered") return { type: "resource_exhaustion_recovered" };
    if (input === "remote_lease_valid") return { type: "remote_lease_valid" };
    if (input === "remote_reconnect_success") return { type: "remote_reconnect_success" };
    throw new Error(`assertions[${index}] unknown assertion ${input}`);
  }
  if (!input || typeof input !== "object") throw new Error(`assertions[${index}] must be a string or object`);
  const obj = input as any;
  if (obj.output_contains != null) return { type: "output_contains", text: String(obj.output_contains) };
  if (obj.file_exists != null) return { type: "file_exists", path: String(obj.file_exists) };
  if (obj.file_absent != null) return { type: "file_absent", path: String(obj.file_absent) };
  if (obj.event_seen != null) return { type: "event_seen", event: String(obj.event_seen) };
  if (obj.fault_injected != null) return { type: "fault_injected", fault: String(obj.fault_injected) };
  if (obj.desktop_screenshot_captured != null) return { type: "desktop_screenshot_captured", path: String(obj.desktop_screenshot_captured) };
  const type = obj.type ?? obj.name;
  if (type === "no_duplicate_side_effect") return { type: "no_duplicate_tool_side_effect" };
  if (type === "no_lost_tool_result" || type === "no_lost_tool_results") return { type: "no_lost_tool_result" };
  if (type === "git_worktree_clean" || type === "no_dangling_worktree") return { type: "git_worktree_clean" };
  if (type === "mcp_stdio_exactly_once") return { type: "mcp_stdio_exactly_once" };
  if (type === "mcp_stdio_resume_consistent") return { type: "mcp_stdio_resume_consistent" };
  if (type === "mcp_stdio_upstream_consistent") return { type: "mcp_stdio_upstream_consistent" };
  if (type === "subagent_exactly_once") return { type: "subagent_exactly_once" };
  if (type === "subagent_resume_consistent") return { type: "subagent_resume_consistent" };
  if (type === "subagent_checkpoint_restored") return { type: "subagent_checkpoint_restored" };
  if (type === "session_clean_recovery") return { type: "session_clean_recovery" };
  if (type === "desktop_screenshot_captured") return { type: "desktop_screenshot_captured", path: obj.path };
  if (type === "desktop_unresponsive_detected") return { type: "desktop_unresponsive_detected" };
  if (type === "resource_exhaustion_recovered") return { type: "resource_exhaustion_recovered" };
  if (type === "remote_lease_valid") return { type: "remote_lease_valid" };
  if (type === "remote_reconnect_success") return { type: "remote_reconnect_success" };
  if (
    type === "exit_zero" ||
    type === "exit_nonzero" ||
    type === "timed_out" ||
    type === "not_timed_out" ||
    type === "no_orphan_process" ||
    type === "git_lock_absent" ||
    type === "task_tests_pass" ||
    type === "git_state_consistent" ||
    type === "no_duplicate_tool_side_effect" ||
    type === "session_resumable" ||
    type === "workspace_matches_expected" ||
    type === "application_eventually_responsive"
    || type === "llm_triggered"
    || type === "mcp_stdio_exactly_once"
    || type === "mcp_stdio_resume_consistent"
    || type === "mcp_stdio_upstream_consistent"
    || type === "subagent_exactly_once"
    || type === "subagent_resume_consistent"
    || type === "subagent_checkpoint_restored"
    || type === "session_clean_recovery"
    || type === "desktop_screenshot_captured"
    || type === "desktop_unresponsive_detected"
    || type === "resource_exhaustion_recovered"
    || type === "remote_lease_valid"
    || type === "remote_reconnect_success"
  ) {
    return { type };
  }
  if (type === "file_exists" || type === "file_absent") return { type, path: obj.path };
  if (type === "file_contains") return { type, path: obj.path, text: obj.text };
  if (type === "output_contains") return { type, text: obj.text };
  if (type === "fault_injected") return { type, fault: obj.fault };
  if (type === "event_seen") return { type, event: String(obj.event ?? obj.name ?? "") };
  throw new Error(`assertions[${index}] unknown assertion ${JSON.stringify(input)}`);
}

export function faultLabel(fault: Fault): string {
  return `${fault.kind}.${fault.action}`;
}

/** Checks that apply when YAML omits assertions. Pass/fail stays empirical. */
export function defaultAssertionNames(input: {
  git: boolean;
  mode: ExperimentMode;
  faults: Fault[];
  recovery: { restart: boolean; resume: boolean };
  verify?: VerifySpec;
  expected?: ExpectedFile[];
  ephemeral?: boolean;
}): string[] {
  const names: string[] = [
    "not_timed_out",
    "no_orphan_process",
    "no_duplicate_tool_side_effect",
    "no_lost_tool_result",
  ];
  if (input.git) {
    names.push("git_lock_absent", "git_state_consistent");
  }
  if (wantsResponsiveCheck(input.faults, input.recovery, input.mode)) {
    names.push("application_eventually_responsive");
  }
  if (input.recovery.resume && input.ephemeral === false) {
    names.push("session_resumable");
  }
  if (input.verify) names.push("task_tests_pass");
  if (input.expected?.length) names.push("workspace_matches_expected");
  if (input.mode === "auto" || input.faults.some((fault) => fault.kind === "llm")) {
    names.push("llm_triggered");
  }
  for (const fault of input.faults) {
    names.push(`fault_injected:${faultLabel(fault)}`);
    names.push(...extrasForFaultKind(fault.kind, fault.action));
  }
  return uniqueNames(names);
}

export function mergeRuntimeDefaultAssertions(assertions: Assertion[], injected: string[]): Assertion[] {
  const names = assertions.map(assertionKey);
  for (const label of injected) {
    names.push(`fault_injected:${label}`);
    if (label.startsWith("llm.")) names.push("llm_triggered");
  }
  return uniqueNames(names).map((name, index) => normalizeAssertion(name, index));
}

function wantsResponsiveCheck(
  faults: Fault[],
  recovery: { restart: boolean; resume: boolean },
  mode: ExperimentMode,
): boolean {
  if (mode === "auto" || recovery.restart || recovery.resume) return true;
  return faults.some((fault) =>
    fault.kind === "llm" ||
    fault.kind === "network" ||
    fault.kind === "mcp" ||
    fault.kind === "resource" ||
    fault.kind === "rule" ||
    fault.kind === "context" ||
    fault.kind === "approval" ||
    (fault.kind === "process" && fault.action === "pause") ||
    (fault.kind === "file" && fault.action === "lock")
  );
}

function extrasForFaultKind(kind: string, action: string): string[] {
  if (kind === "git" && (action === "worktree-leak" || action === "worktree-lock")) return ["git_worktree_clean"];
  if (kind === "mcp") return ["mcp_stdio_exactly_once"];
  if (kind === "subagent") {
    return action === "checkpoint" ? ["subagent_exactly_once", "subagent_checkpoint_restored"] : ["subagent_exactly_once"];
  }
  if (kind === "desktop") {
    if (action === "screenshot") return ["desktop_screenshot_captured"];
    if (action === "freeze" || action === "close_window") return ["desktop_unresponsive_detected"];
    return [];
  }
  if (kind === "resource") return ["resource_exhaustion_recovered"];
  if (kind === "remote") {
    return action === "disconnect" ? ["remote_lease_valid", "remote_reconnect_success"] : ["remote_lease_valid"];
  }
  return [];
}

function assertionKey(assertion: Assertion): string {
  if (assertion.type === "fault_injected") return `fault_injected:${assertion.fault}`;
  if (assertion.type === "event_seen") return `event_seen:${assertion.event}`;
  if (assertion.type === "file_exists") return `file_exists:${assertion.path}`;
  if (assertion.type === "file_absent") return `file_absent:${assertion.path}`;
  if (assertion.type === "file_contains") return `file_contains:${assertion.path}:${assertion.text}`;
  if (assertion.type === "output_contains") return `output_contains:${assertion.text}`;
  if (assertion.type === "desktop_screenshot_captured" && assertion.path) {
    return `desktop_screenshot_captured:${assertion.path}`;
  }
  return assertion.type;
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function faultDueAt(fault: Fault, nativeAt: Map<string, number>): number {
  if (!fault.when) return fault.atMs;
  const seen = nativeAt.get(fault.when);
  if (seen == null) return Number.POSITIVE_INFINITY;
  return seen + fault.atMs;
}

export function validateExperiment(exp: Experiment): string[] {
  const errors: string[] = [];
  if (exp.mode === "auto" && !process.env.AGENTCHAOS_LLM_API_KEY) {
    errors.push("mode: auto requires AGENTCHAOS_LLM_API_KEY");
  }
  if (!exp.target.adapter) errors.push("target.adapter is required");
  if (exp.target.adapter === "generic-cli" && !exp.target.command && !exp.target.executable) {
    errors.push("generic-cli target needs command or executable");
  }
  if (exp.target.sessionHome && (exp.target.sessionHome.startsWith("/") || /^[A-Za-z]:[\\/]/.test(exp.target.sessionHome) || exp.target.sessionHome.includes(".."))) {
    errors.push("target.sessionHome must be a relative directory without ..");
  }
  if (exp.faults.some((fault) => fault.kind === "session") && !exp.target.sessionHome) {
    errors.push("session faults require target.sessionHome for isolated real session storage");
  }
  if (exp.faults.some((fault) => fault.kind === "desktop") && !exp.target.desktop) {
    errors.push("desktop faults require target.desktop: true and a native desktop target");
  }
  if (
    (exp.target.adapter === "codex" ||
      exp.target.adapter === "zcode" ||
      exp.target.adapter === "claude" ||
      exp.target.adapter === "kimi" ||
      exp.target.adapter === "opencode" ||
      exp.target.adapter === "cursor" ||
      exp.target.adapter === "zed") &&
    !exp.target.prompt &&
    !exp.target.command &&
    !exp.target.args &&
    !exp.target.executable
  ) {
    errors.push(`${exp.target.adapter} target needs prompt, command, or executable+args`);
  }
  for (const [i, fault] of exp.faults.entries()) {
    const at = faultPrefix(i, fault.loc);
    if (fault.kind === "file" && fault.path.includes("..")) errors.push(`${at} path must not contain ..`);
    if (fault.kind === "session" && fault.path.includes("..")) errors.push(`${at} path must not contain ..`);
    if (fault.kind === "process" && fault.action === "pause" && !fault.durationMs) {
      errors.push(`${at} process.pause should set duration so the agent can resume`);
    }
    if (fault.kind === "file" && fault.action === "edit" && fault.sizeBytes != null) {
      if (!Number.isFinite(fault.sizeBytes) || fault.sizeBytes < 0) {
        errors.push(`${at} sizeBytes must be a non-negative number`);
      } else if (fault.sizeBytes > 16 * 1024 * 1024) {
        errors.push(`${at} sizeBytes exceeds 16MiB (use resource.disk for disk space stress)`);
      }
    }
    if (fault.kind === "resource" && fault.action === "port" && fault.port != null && (!Number.isInteger(fault.port) || fault.port < 1 || fault.port > 65535)) {
      errors.push(`${at} port must be an integer 1-65535`);
    }
    if (fault.kind === "file" && fault.action === "lock" && !fault.durationMs) {
      errors.push(`${at} file.lock should set duration so the lock can be released`);
    }
    if (fault.kind === "session" && fault.action === "lock" && !fault.durationMs) {
      errors.push(`${at} session.lock should set duration so the lock can be released`);
    }
    if (fault.kind === "approval" && fault.action === "delay" && !fault.durationMs) {
      errors.push(`${at} approval.delay should set duration before sending a reply`);
    }
  }
  if (exp.assertions.some((a) => a.type === "event_seen" && !a.event)) {
    errors.push("event_seen requires an event name");
  }
  if (exp.assertions.some((a) => a.type === "task_tests_pass") && !exp.verify) {
    errors.push("task_tests_pass requires spec.verify");
  }
  if (exp.assertions.some((a) => a.type === "workspace_matches_expected") && !exp.expected?.length) {
    errors.push("workspace_matches_expected requires spec.expected");
  }
  return errors;
}

export function applyPerturbations(prompt: string, perturbations: Perturbation[] = []): string {
  let out = prompt;
  for (const item of perturbations) {
    if (item.type === "prompt_prefix" || item.type === "prompt_noise") out = `${item.text}\n${out}`;
    else out = `${out}\n${item.text}`;
  }
  return out;
}

function normalizeExpected(input: any): ExpectedFile[] | undefined {
  if (!input) return undefined;
  const files = Array.isArray(input) ? input : input.files;
  if (!Array.isArray(files)) return undefined;
  return files.map((file: any) => ({
    path: String(file.path),
    contains: file.contains != null ? String(file.contains) : undefined,
    absent: Boolean(file.absent),
  }));
}

function normalizePerturbations(input: any): Perturbation[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  return input.map((item: any, i: number) => {
    const type = item.type ?? "prompt_suffix";
    if (!["prompt_noise", "prompt_prefix", "prompt_suffix"].includes(type)) {
      throw new Error(`perturbations[${i}] unknown type ${type}`);
    }
    if (!item.text) throw new Error(`perturbations[${i}] needs text`);
    return { type, text: String(item.text) };
  });
}

export function normalizeSuite(raw: any, sourcePath?: string): Suite {
  if (!raw || raw.kind !== "Suite") throw new Error("not a Suite document");
  const spec = raw.spec ?? raw;
  const experiments = (spec.experiments ?? spec.jobs ?? []).map(String);
  const workloads = (spec.workloads ?? []).map(String);
  const profiles = (spec.profiles ?? []).map(String);
  const inject = parseInject(spec.inject, spec.together);
  if (!experiments.length && !(workloads.length && profiles.length) && !(spec.agent && inject?.tokens.length)) {
    throw new Error("Suite needs spec.experiments, spec.workloads + spec.profiles, or spec.agent + spec.inject");
  }
  return {
    apiVersion: raw.apiVersion ?? "agentchaos.dev/v1alpha1",
    kind: "Suite",
    name: raw.metadata?.name ?? spec.name ?? "suite",
    repeat: Number(spec.repeat ?? 1),
    experiments,
    workloads: workloads.length ? workloads : undefined,
    profiles: profiles.length ? profiles : undefined,
    agent: spec.agent != null ? String(spec.agent) : undefined,
    inject: parseInject(spec.inject, spec.together)?.tokens,
    sourcePath,
  };
}

export function normalizeWorkflow(raw: any, sourcePath?: string): Workflow {
  if (!raw || raw.kind !== "Workflow") throw new Error("not a Workflow document");
  const spec = raw.spec ?? raw;
  const tasksIn = spec.tasks ?? spec.templates ?? [];
  if (!Array.isArray(tasksIn) || tasksIn.length === 0) throw new Error("Workflow needs spec.tasks");
  return {
    apiVersion: raw.apiVersion ?? "agentchaos.dev/v1alpha1",
    kind: "Workflow",
    name: raw.metadata?.name ?? spec.name ?? "workflow",
    tasks: tasksIn.map(normalizeWorkflowTask),
    failFast: spec.failFast !== false && spec.continueOnError !== true,
    sourcePath,
  };
}

function normalizeWorkflowTask(item: any, index: number): WorkflowTask {
  if (!item || typeof item !== "object") throw new Error(`tasks[${index}] must be an object`);
  if (Array.isArray(item.serial)) return { type: "serial", experiments: item.serial.map(String) };
  if (Array.isArray(item.parallel)) return { type: "parallel", experiments: item.parallel.map(String) };
  const type = item.type ?? item.mode;
  const experiments = item.experiments ?? item.children ?? item.tasks ?? [];
  if (type !== "serial" && type !== "parallel") throw new Error(`tasks[${index}] needs serial or parallel`);
  if (!Array.isArray(experiments) || experiments.length === 0) throw new Error(`tasks[${index}] needs experiments`);
  return { type, experiments: experiments.map(String) };
}
