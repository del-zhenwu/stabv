import { parse as parseYaml } from "yaml";
import { parseDuration } from "./duration.ts";
import { faultLineNumbers, faultPrefix, type SourceLoc } from "./yaml-loc.ts";

export type AdapterName = "codex" | "claude" | "kimi" | "zcode" | "generic-cli";

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
  action: "lock" | "conflict" | "switch-branch";
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
  action: "delay" | "timeout" | "401" | "429" | "500" | "malformed" | "truncate" | "schema_drift" | "duplicate";
  atMs: number;
  durationMs?: number;
  delayMs?: number;
};

export type ResourceFault = {
  kind: "resource";
  action: "cpu" | "memory" | "port";
  atMs: number;
  durationMs?: number;
  threads?: number;
  mb?: number;
  port?: number;
};

export type InputFault = {
  kind: "input";
  action: "send" | "eof";
  atMs: number;
  durationMs?: number;
  text?: string;
};

export type Fault = (ProcessFault | FileFault | GitFault | NetworkFault | LlmFault | ResourceFault | InputFault) & {
  loc?: SourceLoc;
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
  | { type: "git_lock_absent" }
  | { type: "task_tests_pass" }
  | { type: "git_state_consistent" }
  | { type: "no_duplicate_tool_side_effect" }
  | { type: "session_resumable" }
  | { type: "workspace_matches_expected" }
  | { type: "application_eventually_responsive" };

export type ExpectedFile = {
  path: string;
  contains?: string;
  absent?: boolean;
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
};

export type VerifySpec = {
  executable: string;
  args: string[];
};

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
  recovery: { restart: boolean; resume: boolean };
  assertions: Assertion[];
  verify?: VerifySpec;
  expected?: ExpectedFile[];
  perturbations?: Perturbation[];
  sourcePath?: string;
  raw: unknown;
};

export type Suite = {
  apiVersion: string;
  kind: "Suite";
  name: string;
  repeat: number;
  experiments: string[];
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
  const assertions = (spec.assertions ?? []).map((a: unknown, i: number) => normalizeAssertion(a, i));
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
            (spec.faults ?? []).some((f: any) => f?.type === "git" || f?.kind === "git");
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
    recovery: {
      restart: Boolean(spec.recovery?.restart),
      resume: Boolean(spec.recovery?.resume),
    },
    assertions,
    verify: normalizeVerify(spec.verify ?? spec.grader ?? spec.workload?.verify),
    expected: normalizeExpected(spec.expected ?? spec.workload?.expected),
    perturbations: normalizePerturbations(spec.perturbations ?? spec.profile?.perturbations),
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

function normalizeFault(input: any, index: number, loc?: SourceLoc): Fault {
  const at = (msg: string) => `${faultPrefix(index, loc)} ${msg}`;
  if (!input || typeof input !== "object") throw new Error(at("must be an object"));
  const atMs = parseDuration(input.at ?? 0, `${faultPrefix(index, loc)}.at`);
  const durationMs = input.duration != null ? parseDuration(input.duration, `${faultPrefix(index, loc)}.duration`) : undefined;
  const type = String(input.type ?? input.kind ?? "");
  if (type === "process_kill") return { kind: "process", action: "kill", atMs, target: input.target };
  if (type === "file_edit") {
    if (!input.path) throw new Error(at("file_edit requires path"));
    return { kind: "file", action: "edit", atMs, path: input.path, content: input.content };
  }
  if (type === "network_delay") {
    return { kind: "network", action: "delay", atMs, durationMs, delayMs: durationMs };
  }
  if (type === "process") {
    const action = input.action ?? "kill";
    if (!["kill", "pause", "restart"].includes(action)) {
      throw new Error(at(`unknown process action ${action}`));
    }
    return { kind: "process", action, atMs, durationMs, target: input.target };
  }
  if (type === "file") {
    const action = input.action ?? "edit";
    if (!["edit", "delete", "rename", "chmod", "symlink", "lock"].includes(action)) {
      throw new Error(at(`unknown file action ${action}`));
    }
    if (!input.path) throw new Error(at("file fault requires path"));
    return {
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
    };
  }
  if (type === "git") {
    const action = input.action ?? "lock";
    if (!["lock", "conflict", "switch-branch"].includes(action)) {
      throw new Error(at(`unknown git action ${action}`));
    }
    return { kind: "git", action, atMs, durationMs, path: input.path, branch: input.branch, content: input.content };
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
    return { kind: "network", action, atMs, durationMs, delayMs };
  }
  if (type === "llm") {
    const action = String(input.action ?? "429");
    if (!["delay", "timeout", "401", "429", "500", "malformed", "truncate", "schema_drift", "duplicate"].includes(action)) {
      throw new Error(at(`unknown llm action ${action}`));
    }
    const delayMs =
      input.delayMs != null
        ? parseDuration(input.delayMs, `${faultPrefix(index, loc)}.delayMs`)
        : input.delay != null
          ? parseDuration(input.delay, `${faultPrefix(index, loc)}.delay`)
          : durationMs;
    return { kind: "llm", action: action as LlmFault["action"], atMs, durationMs, delayMs };
  }
  if (type === "resource") {
    const action = input.action ?? "cpu";
    if (!["cpu", "memory", "port"].includes(action)) {
      throw new Error(at(`unknown resource action ${action}`));
    }
    return {
      kind: "resource",
      action,
      atMs,
      durationMs,
      threads: input.threads,
      mb: input.mb,
      port: input.port != null ? Number(input.port) : undefined,
    };
  }
  if (type === "input") {
    const action = input.action ?? "send";
    if (!["send", "eof"].includes(action)) {
      throw new Error(at(`unknown input action ${action}`));
    }
    if (action === "send" && input.text == null) throw new Error(at("input.send requires text"));
    return { kind: "input", action, atMs, durationMs, text: input.text != null ? String(input.text) : undefined };
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
    throw new Error(`assertions[${index}] unknown assertion ${input}`);
  }
  if (!input || typeof input !== "object") throw new Error(`assertions[${index}] must be a string or object`);
  const obj = input as any;
  const type = obj.type ?? obj.name;
  if (type === "no_duplicate_side_effect") return { type: "no_duplicate_tool_side_effect" };
  if (type === "exit_zero" || type === "exit_nonzero" || type === "timed_out" || type === "not_timed_out" || type === "no_orphan_process" || type === "git_lock_absent" || type === "task_tests_pass" || type === "git_state_consistent" || type === "no_duplicate_tool_side_effect" || type === "session_resumable" || type === "workspace_matches_expected" || type === "application_eventually_responsive") {
    return { type };
  }
  if (type === "file_exists" || type === "file_absent") return { type, path: obj.path };
  if (type === "file_contains") return { type, path: obj.path, text: obj.text };
  if (type === "output_contains") return { type, text: obj.text };
  if (type === "fault_injected") return { type, fault: obj.fault };
  throw new Error(`assertions[${index}] unknown assertion ${JSON.stringify(input)}`);
}

export function faultLabel(fault: Fault): string {
  return `${fault.kind}.${fault.action}`;
}

export function validateExperiment(exp: Experiment): string[] {
  const errors: string[] = [];
  if (!exp.target.adapter) errors.push("target.adapter is required");
  if (exp.target.adapter === "generic-cli" && !exp.target.command && !exp.target.executable) {
    errors.push("generic-cli target needs command or executable");
  }
  if (
    (exp.target.adapter === "codex" || exp.target.adapter === "zcode") &&
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
    if (fault.kind === "process" && fault.action === "pause" && !fault.durationMs) {
      errors.push(`${at} process.pause should set duration so the agent can resume`);
    }
    if (fault.kind === "file" && fault.action === "edit" && fault.sizeBytes != null) {
      if (!Number.isFinite(fault.sizeBytes) || fault.sizeBytes < 0) {
        errors.push(`${at} sizeBytes must be a non-negative number`);
      } else if (fault.sizeBytes > 16 * 1024 * 1024) {
        errors.push(`${at} sizeBytes exceeds 16MiB (disk-full faults are not implemented yet; see docs/roadmap.md)`);
      }
    }
    if (fault.kind === "resource" && fault.action === "port" && fault.port != null && (!Number.isInteger(fault.port) || fault.port < 1 || fault.port > 65535)) {
      errors.push(`${at} port must be an integer 1-65535`);
    }
    if (fault.kind === "file" && fault.action === "lock" && !fault.durationMs) {
      errors.push(`${at} file.lock should set duration so the lock can be released`);
    }
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
  const experiments = spec.experiments ?? spec.jobs ?? [];
  if (!Array.isArray(experiments) || experiments.length === 0) throw new Error("Suite needs spec.experiments");
  return {
    apiVersion: raw.apiVersion ?? "agentchaos.dev/v1alpha1",
    kind: "Suite",
    name: raw.metadata?.name ?? spec.name ?? "suite",
    repeat: Number(spec.repeat ?? 1),
    experiments: experiments.map(String),
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
