import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Experiment, TargetSpec } from "./spec.ts";

export type LaunchPlan = {
  executable: string;
  args: string[];
  env: Record<string, string>;
  shell: boolean;
  capabilities: string[];
};

const CODEX_BUNDLED_MAC = "/Applications/ChatGPT.app/Contents/Resources/codex";
const ZCODE_BUNDLED_MAC = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const DEFAULT_PROMPT = "Inspect the workspace and reply with a one-line summary. Do not modify files.";
const ZCODE_CAPS = ["cli", "json-events", "session-resume"];

export function planLaunch(exp: Experiment, extraEnv: Record<string, string> = {}): LaunchPlan {
  const t = exp.target;
  const env = { ...(t.env ?? {}), ...extraEnv };
  switch (t.adapter) {
    case "codex":
      return planCodex(t, env);
    case "claude":
      return planNamed("claude", t, env, ["cli", "session-resume"]);
    case "kimi":
      return planNamed("kimi", t, env, ["cli"]);
    case "zcode":
      return planZcode(t, env);
    default:
      return planGeneric(t, env);
  }
}

export function discoverAgents(): { adapter: string; executable: string; present: boolean }[] {
  const codex = resolveCodex();
  const zcode = resolveZcode();
  return [
    { adapter: "codex", executable: codex, present: binaryPresent(codex) },
    { adapter: "claude", executable: resolveOnPath("claude") ?? "claude", present: which("claude") },
    { adapter: "kimi", executable: resolveOnPath("kimi") ?? "kimi", present: which("kimi") },
    { adapter: "zcode", executable: zcode, present: binaryPresent(zcode) },
  ];
}

/** Rebuild argv after kill when `recovery.resume` is set. Returns true if resume flags were applied. */
export function applyResumeArgs(plan: LaunchPlan, t: TargetSpec, sessionId?: string): boolean {
  if (t.adapter === "codex" && t.ephemeral === false) {
    plan.args = ["exec", "resume", "--last", "--color", "never"];
    if (t.json !== false) plan.args.push("--json");
    return true;
  }
  if (t.adapter === "zcode") {
    const prefix = scriptPrefix(plan);
    const flags: string[] = [];
    if (sessionId) flags.push("--resume", sessionId);
    else flags.push("--continue");
    if (t.json !== false) flags.push("--json");
    flags.push("--no-color", "--mode", zcodeMode(t));
    if (t.extraArgs) flags.push(...t.extraArgs);
    plan.args = [...prefix, ...flags];
    return true;
  }
  return false;
}

function planCodex(t: TargetSpec, env: Record<string, string>): LaunchPlan {
  if (t.command) return planGeneric(t, env);
  const executable = t.executable ?? resolveCodex();
  if (t.args?.length) {
    return { executable, args: t.args, env, shell: false, capabilities: ["cli", "json-events", "session-resume"] };
  }
  const args = ["exec", "--skip-git-repo-check", "--color", "never"];
  const json = t.json !== false;
  if (json) args.push("--json");
  if (t.ephemeral !== false) args.push("--ephemeral");
  const sandbox = t.sandbox ?? "read-only";
  args.push("-s", sandbox);
  if (t.bypassApprovals) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (t.extraArgs) args.push(...t.extraArgs);
  args.push(t.prompt ?? "Inspect the workspace and reply with a one-line summary. Do not modify files.");
  return { executable, args, env, shell: false, capabilities: ["cli", "json-events", "session-resume"] };
}

function planZcode(t: TargetSpec, env: Record<string, string>): LaunchPlan {
  if (t.command) return planGeneric(t, env);
  const merged = { ...zcodeDesktopEnv(), ...env };
  const bin = t.executable ?? resolveZcode();
  if (t.args?.length) return wrapScript(bin, t.args, merged, ZCODE_CAPS);
  const args = ["--prompt", t.prompt ?? DEFAULT_PROMPT];
  if (t.json !== false) args.push("--json");
  args.push("--no-color", "--mode", zcodeMode(t));
  if (t.extraArgs) args.push(...t.extraArgs);
  return wrapScript(bin, args, merged, ZCODE_CAPS);
}

function zcodeDesktopEnv(): Record<string, string> {
  if (process.env.ZCODE_MODEL) return {};
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const desktop = join(home, ".zcode", "v2", "config.json");
  if (!existsSync(desktop)) return {};
  try {
    const raw = JSON.parse(readFileSync(desktop, "utf8")) as {
      provider?: Record<string, { enabled?: boolean; options?: { apiKey?: string; baseURL?: string }; models?: Record<string, unknown> }>;
    };
    const entries = Object.entries(raw.provider ?? {});
    const picked =
      entries.find(([, p]) => p?.enabled === true && p.options?.apiKey && p.options?.baseURL) ??
      entries.find(([, p]) => p?.options?.apiKey && p?.options?.baseURL);
    if (!picked) return {};
    const [providerId, provider] = picked;
    const models = Object.keys(provider.models ?? {});
    const modelId = models.includes("GLM-5.3") ? "GLM-5.3" : models[0];
    if (!modelId || !provider.options?.apiKey || !provider.options.baseURL) return {};
    const env: Record<string, string> = {
      ZCODE_MODEL: `${providerId}/${modelId}`,
      ZCODE_API_KEY: provider.options.apiKey,
      ZCODE_BASE_URL: provider.options.baseURL,
    };
    return env;
  } catch {
    return {};
  }
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

function planNamed(bin: string, t: TargetSpec, env: Record<string, string>, capabilities: string[]): LaunchPlan {
  if (t.command) return planGeneric(t, env);
  const executable = t.executable ?? resolveOnPath(bin) ?? bin;
  const args = t.args ?? [...(t.extraArgs ?? []), ...(t.prompt ? [t.prompt] : [])];
  return { executable, args, env, shell: false, capabilities };
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

function resolveCodex(): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  for (const candidate of codexCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return resolveOnPath("codex") ?? "codex";
}

function resolveZcode(): string {
  if (process.env.ZCODE_BIN) return process.env.ZCODE_BIN;
  for (const candidate of zcodeCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return resolveOnPath("zcode") ?? "zcode";
}

function codexCandidates(): string[] {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const roaming = process.env.APPDATA ?? "";
    const home = process.env.USERPROFILE ?? "";
    return [
      join(local, "Programs", "Codex", "codex.exe"),
      join(local, "Programs", "codex", "codex.exe"),
      join(local, "Programs", "ChatGPT", "codex.exe"),
      join(roaming, "npm", "codex.cmd"),
      join(roaming, "npm", "codex.exe"),
      join(home, ".local", "bin", "codex.exe"),
      join(home, "AppData", "Local", "codex", "codex.exe"),
    ].filter(Boolean);
  }
  return [CODEX_BUNDLED_MAC];
}

function zcodeCandidates(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const roaming = process.env.APPDATA ?? "";
    const pf = process.env.ProgramFiles ?? "";
    return [
      join(local, "Programs", "ZCode", "resources", "glm", "zcode.cjs"),
      join(local, "Programs", "zcode", "resources", "glm", "zcode.cjs"),
      join(pf, "ZCode", "resources", "glm", "zcode.cjs"),
      join(roaming, "npm", "zcode.cmd"),
      join(home, ".local", "bin", "zcode.exe"),
    ].filter(Boolean);
  }
  return [
    ZCODE_BUNDLED_MAC,
    join(home, "Applications", "ZCode.app", "Contents", "Resources", "glm", "zcode.cjs"),
    join(home, ".local", "bin", "zcode"),
  ].filter(Boolean);
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
