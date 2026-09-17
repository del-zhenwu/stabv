import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterName, Experiment, TargetSpec } from "./spec.ts";

export type LaunchPlan = {
  executable: string;
  args: string[];
  env: Record<string, string>;
  shell: boolean;
  capabilities: string[];
};

export interface AgentDescriptor {
  adapter: AdapterName;
  envVar: string;
  canonicalBinNames: string[];
  capabilities: string[];
  defaultPrompt?: string;
  plan(target: TargetSpec, env: Record<string, string>, descriptor: AgentDescriptor): LaunchPlan;
  applyResume(plan: LaunchPlan, target: TargetSpec, sessionId?: string): boolean;
}

const DEFAULT_PROMPT = "Inspect the workspace and reply with a one-line summary. Do not modify files.";

/**
 * Standard probe locations for bundled desktop applications when not in system PATH.
 * Separated cleanly from the core execution engine (inspired by Harbor installed agents).
 */
const DESKTOP_PROBE_REGISTRY: Partial<Record<AdapterName, { mac?: string[]; win?: string[] }>> = {
  codex: {
    mac: ["/Applications/ChatGPT.app/Contents/Resources/codex"],
    win: [
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Codex", "codex.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Programs", "ChatGPT", "codex.exe"),
    ],
  },
  zcode: {
    mac: [
      "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      join(process.env.HOME ?? "", "Applications", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs"),
    ],
    win: [
      join(process.env.LOCALAPPDATA ?? "", "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
      join(process.env.ProgramFiles ?? "", "ZCode", "resources", "glm", "zcode.cjs"),
    ],
  },
};

const CODEX_DESCRIPTOR: AgentDescriptor = {
  adapter: "codex",
  envVar: "CODEX_BIN",
  canonicalBinNames: ["codex"],
  capabilities: ["cli", "json-events", "session-resume"],
  defaultPrompt: DEFAULT_PROMPT,
  plan(t: TargetSpec, env: Record<string, string>, descriptor: AgentDescriptor): LaunchPlan {
    if (t.command) return planGeneric(t, env);
    const executable = resolveAgentExecutable(t, descriptor);
    if (t.args?.length) {
      return { executable, args: t.args, env, shell: false, capabilities: descriptor.capabilities };
    }
    const args = ["exec", "--skip-git-repo-check", "--color", "never"];
    const json = t.json !== false;
    if (json) args.push("--json");
    if (t.ephemeral !== false) args.push("--ephemeral");
    const sandbox = t.sandbox ?? "read-only";
    args.push("-s", sandbox);
    if (t.bypassApprovals) args.push("--dangerously-bypass-approvals-and-sandbox");
    if (t.extraArgs) args.push(...t.extraArgs);
    args.push(t.prompt ?? descriptor.defaultPrompt ?? DEFAULT_PROMPT);
    return { executable, args, env, shell: false, capabilities: descriptor.capabilities };
  },
  applyResume(plan: LaunchPlan, t: TargetSpec): boolean {
    if (t.ephemeral === false) {
      plan.args = ["exec", "resume", "--last", "--color", "never"];
      if (t.json !== false) plan.args.push("--json");
      return true;
    }
    return false;
  },
};

const CLAUDE_DESCRIPTOR: AgentDescriptor = {
  adapter: "claude",
  envVar: "CLAUDE_BIN",
  canonicalBinNames: ["claude"],
  capabilities: ["cli", "json-events", "session-resume"],
  defaultPrompt: DEFAULT_PROMPT,
  plan(t: TargetSpec, env: Record<string, string>, descriptor: AgentDescriptor): LaunchPlan {
    if (t.command) return planGeneric(t, env);
    const executable = resolveAgentExecutable(t, descriptor);
    if (t.args?.length) return { executable, args: t.args, env, shell: false, capabilities: descriptor.capabilities };
    return { executable, args: claudeArgs(t), env, shell: false, capabilities: descriptor.capabilities };
  },
  applyResume(plan: LaunchPlan, t: TargetSpec, sessionId?: string): boolean {
    plan.args = claudeArgs(t, sessionId ? { resume: sessionId } : { continueLast: true });
    return true;
  },
};

const KIMI_DESCRIPTOR: AgentDescriptor = {
  adapter: "kimi",
  envVar: "KIMI_BIN",
  canonicalBinNames: ["kimi"],
  capabilities: ["cli", "json-events", "session-resume"],
  defaultPrompt: DEFAULT_PROMPT,
  plan(t: TargetSpec, env: Record<string, string>, descriptor: AgentDescriptor): LaunchPlan {
    if (t.command) return planGeneric(t, env);
    const executable = resolveAgentExecutable(t, descriptor);
    if (t.args?.length) return { executable, args: t.args, env, shell: false, capabilities: descriptor.capabilities };
    return { executable, args: kimiArgs(t), env, shell: false, capabilities: descriptor.capabilities };
  },
  applyResume(plan: LaunchPlan, t: TargetSpec, sessionId?: string): boolean {
    plan.args = kimiArgs(t, sessionId ? { resume: sessionId } : { continueLast: true });
    return true;
  },
};

const ZCODE_DESCRIPTOR: AgentDescriptor = {
  adapter: "zcode",
  envVar: "ZCODE_BIN",
  canonicalBinNames: ["zcode", "zcode.cjs"],
  capabilities: ["cli", "json-events", "session-resume"],
  defaultPrompt: DEFAULT_PROMPT,
  plan(t: TargetSpec, env: Record<string, string>, descriptor: AgentDescriptor): LaunchPlan {
    if (t.command) return planGeneric(t, env);
    const merged = { ...zcodeCliEnv(), ...env };
    const bin = resolveAgentExecutable(t, descriptor);
    if (t.args?.length) return wrapScript(bin, t.args, merged, descriptor.capabilities);
    const args = ["--prompt", t.prompt ?? descriptor.defaultPrompt ?? DEFAULT_PROMPT];
    if (t.json !== false) args.push("--json");
    args.push("--no-color", "--mode", zcodeMode(t));
    if (t.extraArgs) args.push(...t.extraArgs);
    return wrapScript(bin, args, merged, descriptor.capabilities);
  },
  applyResume(plan: LaunchPlan, t: TargetSpec, sessionId?: string): boolean {
    const prefix = scriptPrefix(plan);
    const flags: string[] = [];
    if (sessionId) flags.push("--resume", sessionId);
    else flags.push("--continue");
    if (t.json !== false) flags.push("--json");
    flags.push("--no-color", "--mode", zcodeMode(t));
    if (t.extraArgs) flags.push(...t.extraArgs);
    plan.args = [...prefix, ...flags];
    return true;
  },
};

const GENERIC_DESCRIPTOR: AgentDescriptor = {
  adapter: "generic-cli",
  envVar: "GENERIC_CLI_BIN",
  canonicalBinNames: [],
  capabilities: ["cli"],
  defaultPrompt: DEFAULT_PROMPT,
  plan(t: TargetSpec, env: Record<string, string>): LaunchPlan {
    return planGeneric(t, env);
  },
  applyResume(): boolean {
    return false;
  },
};

export const AGENT_REGISTRY: Record<AdapterName, AgentDescriptor> = {
  codex: CODEX_DESCRIPTOR,
  claude: CLAUDE_DESCRIPTOR,
  kimi: KIMI_DESCRIPTOR,
  zcode: ZCODE_DESCRIPTOR,
  "generic-cli": GENERIC_DESCRIPTOR,
};

export function planLaunch(exp: Experiment, extraEnv: Record<string, string> = {}): LaunchPlan {
  const t = exp.target;
  const env = { ...(t.env ?? {}), ...extraEnv };
  const descriptor = AGENT_REGISTRY[t.adapter] ?? AGENT_REGISTRY["generic-cli"];
  return descriptor.plan(t, env, descriptor);
}

export function discoverAgents(): { adapter: string; executable: string; present: boolean }[] {
  const result: { adapter: string; executable: string; present: boolean }[] = [];
  for (const [adapter, descriptor] of Object.entries(AGENT_REGISTRY)) {
    if (adapter === "generic-cli") continue;
    const executable = resolveAgentExecutable({ adapter: descriptor.adapter }, descriptor);
    result.push({
      adapter,
      executable,
      present: binaryPresent(executable),
    });
  }
  return result;
}

/** Rebuild argv after kill when `recovery.resume` is set. Returns true if resume flags were applied. */
export function applyResumeArgs(plan: LaunchPlan, t: TargetSpec, sessionId?: string): boolean {
  const descriptor = AGENT_REGISTRY[t.adapter];
  if (descriptor) return descriptor.applyResume(plan, t, sessionId);
  return false;
}

export function resolveAgentExecutable(t: TargetSpec, descriptor: AgentDescriptor): string {
  // 1. Explicit user-provided executable in spec
  if (t.executable) return t.executable;

  // 2. Specific environment variable override (e.g. ZCODE_BIN, CODEX_BIN)
  const envVal = process.env[descriptor.envVar];
  if (envVal) return envVal;

  // 3. Standard system PATH resolution
  for (const name of descriptor.canonicalBinNames) {
    const onPath = resolveOnPath(name);
    if (onPath) return onPath;
  }

  // 4. Standard global package manager bins (~/.local/bin, npm global)
  for (const name of descriptor.canonicalBinNames) {
    for (const cand of npmBinCandidates(name)) {
      if (existsSync(cand)) return cand;
    }
  }

  // 5. Desktop Application Bundle probe fallback (cleanly separated)
  const probe = DESKTOP_PROBE_REGISTRY[descriptor.adapter];
  if (probe) {
    const platformList = process.platform === "win32" ? probe.win : probe.mac;
    for (const cand of platformList ?? []) {
      if (cand && existsSync(cand)) return cand;
    }
  }

  // Fallback to primary canonical name
  return descriptor.canonicalBinNames[0] ?? "cli";
}

function claudeArgs(t: TargetSpec, resume?: { resume?: string; continueLast?: boolean }): string[] {
  const args = ["--print"];
  if (resume?.resume) args.push("--resume", resume.resume);
  else if (resume?.continueLast) args.push("--continue");
  if (t.json !== false) args.push("--output-format", "stream-json");
  if (t.bypassApprovals || t.sandbox === "danger-full-access") args.push("--dangerously-skip-permissions");
  else if (t.sandbox === "read-only") args.push("--permission-mode", "plan");
  else if (t.sandbox === "workspace-write") args.push("--permission-mode", "acceptEdits");
  if (t.extraArgs) args.push(...t.extraArgs);
  args.push(t.prompt ?? DEFAULT_PROMPT);
  return args;
}

function kimiArgs(t: TargetSpec, resume?: { resume?: string; continueLast?: boolean }): string[] {
  const args = ["--print"];
  if (resume?.resume) args.push("--resume", resume.resume);
  else if (resume?.continueLast) args.push("--continue");
  if (t.json !== false) args.push("--output-format", "json");
  if (t.bypassApprovals || t.sandbox === "danger-full-access") args.push("--yolo");
  if (t.extraArgs) args.push(...t.extraArgs);
  args.push(t.prompt ?? DEFAULT_PROMPT);
  return args;
}

type ZcodeProvider = {
  enabled?: boolean;
  options?: { apiKey?: string; baseURL?: string };
  models?: Record<string, unknown>;
};

/** True when YAML uses the discovered ZCode CLI (not a test stub via target.executable). */
export function usesDiscoveredZcodeCli(target: { adapter?: string; executable?: string }): boolean {
  return target.adapter === "zcode" && !target.executable;
}

/** 套餐 OAuth / zcode.z.ai 要过人机验证，CLI 不能用。 */
export function isZcodeCaptchaEndpoint(providerId: string, baseURL: string): boolean {
  const id = providerId.toLowerCase();
  const url = baseURL.toLowerCase();
  return (
    id.includes("start-plan") ||
    id.includes("coding-plan") ||
    url.includes("zcode-plan") ||
    url.includes("zcode.z.ai")
  );
}

/**
 * ZCode 有 CLI，只走 CLI：用 API Key，不抄桌面套餐登录。
 * 没有 CLI 的产品才走桌面。
 */
/** Gateway docs often end with `/v1`. ZCode appends `/v1/messages`; strip the duplicate. */
export function normalizeZcodeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function firstEnv(proc: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = proc[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function zcodeCliEnv(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): Record<string, string> {
  const proc = opts.env ?? process.env;
  const fromFiles = readZcodeApiKeyConfig(opts.home ?? proc.HOME ?? proc.USERPROFILE ?? "");
  const out: Record<string, string> = { ...fromFiles };
  const key = firstEnv(proc, ["ZCODE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  const url = firstEnv(proc, ["ZCODE_BASE_URL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]);
  const model = firstEnv(proc, ["ZCODE_MODEL", "OPENAI_MODEL"]);
  if (key) out.ZCODE_API_KEY = key;
  if (url) out.ZCODE_BASE_URL = url;
  if (model) out.ZCODE_MODEL = model;
  if (out.ZCODE_BASE_URL) out.ZCODE_BASE_URL = normalizeZcodeBaseUrl(out.ZCODE_BASE_URL);
  return out;
}

/** @deprecated use zcodeCliEnv; kept so older imports keep compiling */
export function zcodeDesktopEnv(opts?: { home?: string; env?: NodeJS.ProcessEnv }): Record<string, string> {
  return zcodeCliEnv(opts);
}

export function zcodeCliCredentialError(creds: Record<string, string> = zcodeCliEnv()): string | undefined {
  const key = creds.ZCODE_API_KEY?.trim() ?? "";
  const url = creds.ZCODE_BASE_URL?.trim() ?? "";
  if (!key || !url) {
    return "ZCode 有 CLI，只走 CLI。请设置 ZCODE_API_KEY、ZCODE_BASE_URL、ZCODE_MODEL（网关文档上的地址即可，带不带 /v1 都行；也可使用 OPENAI_API_KEY / OPENAI_BASE_URL）。桌面 Coding Plan / 验证码登录不能用于 CLI。没有 CLI 的产品才走桌面。";
  }
  if (isZcodeCaptchaEndpoint(creds.ZCODE_MODEL ?? "", url)) {
    return `ZCODE_BASE_URL 是 Coding Plan 验证码接口（${url}）。请改成 open.bigmodel.cn 或 api.z.ai 的 API Key 地址。`;
  }
  return undefined;
}

function readZcodeApiKeyConfig(home: string): Record<string, string> {
  if (!home) return {};
  const files = [join(home, ".zcode", "cli", "config.json"), join(home, ".zcode", "v2", "config.json")];
  for (const file of files) {
    const picked = pickZcodeApiKeyProvider(file);
    if (picked) return picked;
  }
  return {};
}

function pickZcodeApiKeyProvider(file: string): Record<string, string> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { provider?: Record<string, ZcodeProvider> };
    const usable = Object.entries(raw.provider ?? {}).filter(([id, p]) => isZcodeApiKeyProvider(id, p));
    const picked = usable.find(([, p]) => p.enabled === true) ?? usable[0];
    if (!picked) return undefined;
    const [providerId, provider] = picked;
    const apiKey = provider.options?.apiKey?.trim() ?? "";
    const baseURL = provider.options?.baseURL?.trim() ?? "";
    const models = Object.keys(provider.models ?? {});
    const modelId = models.includes("GLM-5.3") ? "GLM-5.3" : models[0];
    if (!apiKey || !baseURL || !modelId) return undefined;
    return {
      ZCODE_MODEL: `${providerId}/${modelId}`,
      ZCODE_API_KEY: apiKey,
      ZCODE_BASE_URL: baseURL,
    };
  } catch {
    return undefined;
  }
}

function isZcodeApiKeyProvider(id: string, provider: ZcodeProvider | undefined): boolean {
  const apiKey = provider?.options?.apiKey?.trim() ?? "";
  const baseURL = provider?.options?.baseURL?.trim() ?? "";
  if (!apiKey || !baseURL) return false;
  return !isZcodeCaptchaEndpoint(id, baseURL);
}

function zcodeMode(t: TargetSpec): string {
  if (t.bypassApprovals || t.sandbox === "danger-full-access") return "yolo";
  if (t.sandbox === "workspace-write") return "build";
  if (t.sandbox === "read-only") return "plan";
  return "yolo";
}

function wrapScript(bin: string, args: string[], env: Record<string, string>, capabilities: string[]): LaunchPlan {
  if (/\.(cjs|mjs|js)$/i.test(bin)) {
    return { executable: process.execPath, args: [bin, ...args], env, shell: false, capabilities };
  }
  return { executable: bin, args, env, shell: false, capabilities };
}

function scriptPrefix(plan: LaunchPlan): string[] {
  const first = plan.args[0];
  if (typeof first === "string" && /\.(cjs|mjs|js)$/i.test(first)) return [first];
  return [];
}

function planGeneric(t: TargetSpec, env: Record<string, string>): LaunchPlan {
  if (t.executable) {
    return { executable: t.executable, args: t.args ?? [], env, shell: false, capabilities: ["cli"] };
  }
  if (!t.command) throw new Error("generic-cli target requires command or executable");
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", t.command],
      env,
      shell: false,
      capabilities: ["cli"],
    };
  }
  return { executable: "/bin/sh", args: ["-lc", t.command], env, shell: false, capabilities: ["cli"] };
}

function npmBinCandidates(name: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA ?? "";
    const local = process.env.LOCALAPPDATA ?? "";
    return [
      join(roaming, "npm", `${name}.cmd`),
      join(roaming, "npm", `${name}.exe`),
      join(local, "npm", `${name}.cmd`),
      join(home, ".local", "bin", `${name}.exe`),
    ].filter(Boolean);
  }
  return [join(home, ".local", "bin", name), join(home, ".npm-global", "bin", name)].filter(Boolean);
}

function pathDirs(): string[] {
  const path = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  return path.split(sep).filter(Boolean);
}

function executableExts(): string[] {
  if (process.platform !== "win32") return [""];
  const raw = process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  return ["", ...raw.split(";").filter(Boolean)];
}

function resolveOnPath(bin: string): string | undefined {
  if (bin.includes("/") || bin.includes("\\")) return existsSync(bin) ? bin : undefined;
  for (const dir of pathDirs()) {
    for (const ext of executableExts()) {
      const name = ext && !bin.toLowerCase().endsWith(ext.toLowerCase()) ? bin + ext : bin;
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

function which(bin: string): boolean {
  return Boolean(resolveOnPath(bin));
}

function binaryPresent(path: string): boolean {
  if (path.includes("/") || path.includes("\\")) return existsSync(path);
  return which(path);
}
