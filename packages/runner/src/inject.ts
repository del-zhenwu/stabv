import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot } from "./paths.ts";

export type InjectSpec = {
  tokens: string[];
  together: boolean;
};

/** Default product inject: every kind under examples/profiles/<kind>/. */
export const DEFAULT_INJECT = ["llm", "resource", "file", "git", "network", "process"];

export function comboLabel(agent?: string, inject?: string[]): string {
  const who = agent && agent !== "generic-cli" ? agent : undefined;
  const what = inject?.length ? inject.join(" / ") : undefined;
  if (who && what) return `${who} · ${what}`;
  return who ?? what ?? "";
}

export function parseInject(input: unknown, togetherFlag?: unknown): InjectSpec | undefined {
  const together = togetherFlag === true || (input != null && typeof input === "object" && !Array.isArray(input) && (input as { together?: unknown }).together === true);
  if (input == null) return together ? { tokens: [], together } : undefined;
  if (typeof input === "string") return { tokens: [input], together };
  if (Array.isArray(input)) return { tokens: input.map(String).filter(Boolean), together };
  if (typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const tokens: string[] = [];
  if (Array.isArray(obj.kinds)) tokens.push(...obj.kinds.map(String));
  if (Array.isArray(obj.items)) tokens.push(...obj.items.map(String));
  for (const [key, value] of Object.entries(obj)) {
    if (key === "together" || key === "kinds" || key === "items") continue;
    if (value === true || value === "true") tokens.push(key);
    else if (typeof value === "string") tokens.push(value.includes("/") ? value : `${key}/${value}`);
    else if (Array.isArray(value)) {
      for (const item of value) tokens.push(`${key}/${String(item)}`);
    }
  }
  if (!tokens.length) return together ? { tokens: [], together } : undefined;
  return { tokens, together };
}

export function resolveInjectProfiles(tokens: string[], fromDir = process.cwd()): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const found = resolveToken(token, fromDir);
    if (!found.length) throw new Error(`inject: no profiles for "${token}" (looked under examples/profiles/)`);
    out.push(...found);
  }
  return unique(out);
}

export function implicitWorkload(adapter?: string): string | undefined {
  if (!adapter || adapter === "generic-cli") return undefined;
  const path = join(repoRoot(), "examples", "workloads", `${adapter}.yaml`);
  return existsSync(path) ? path : undefined;
}

function resolveToken(token: string, fromDir: string): string[] {
  const normalized = token.replace(/\\/g, "/").replace(/\.yaml$/i, "");
  const [kind, name] = normalized.includes("/") ? splitOnce(normalized, "/") : [normalized, undefined];
  if (name) {
    const file = findProfileFile(kind, name, fromDir);
    return file ? [file] : [];
  }
  const dir = findProfileDir(kind, fromDir);
  if (dir) {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
      .sort()
      .map((file) => join(dir, file));
  }
  const top = findProfileFile("", kind, fromDir);
  return top ? [top] : [];
}

function findProfileDir(kind: string, fromDir: string): string | undefined {
  return [
    resolve(fromDir, "profiles", kind),
    resolve(fromDir, "../profiles", kind),
    join(repoRoot(), "examples", "profiles", kind),
  ].find((p) => existsSync(p));
}

function findProfileFile(kind: string, name: string, fromDir: string): string | undefined {
  const rel = kind ? `${kind}/${name}` : name;
  return [
    resolve(fromDir, "profiles", `${rel}.yaml`),
    resolve(fromDir, "../profiles", `${rel}.yaml`),
    join(repoRoot(), "examples", "profiles", `${rel}.yaml`),
    join(repoRoot(), "examples", "profiles", `${name}.yaml`),
  ].find((p) => existsSync(p));
}

function splitOnce(value: string, sep: string): [string, string] {
  const i = value.indexOf(sep);
  return [value.slice(0, i), value.slice(i + sep.length)];
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
