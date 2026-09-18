import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv(join(repo, ".env"));

const creds = {
  key: firstEnv(["ZCODE_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]),
  baseUrl: firstEnv(["ZCODE_BASE_URL", "LLM_BASE_URL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]),
  model: firstEnv(["ZCODE_MODEL", "LLM_MODEL", "OPENAI_MODEL"]) ?? "glm-5.3-flash",
};
const bin = process.env.AGENTCHAOS_BIN?.trim() || which("agentchaos");
const cases = bin && creds.key && creds.baseUrl ? listCases(bin) : [];

describe("zcode user-path e2e", () => {
  it("packed CLI is installed and gateway env is set", () => {
    assert.ok(bin && existsSync(bin), "找不到 agentchaos。先 npm run pack 并安装 tgz，或设置 AGENTCHAOS_BIN。");
    assert.ok(creds.key && creds.baseUrl, "缺少网关配置。CI 用 Secrets；本地在 .env 写 ZCODE_API_KEY、ZCODE_BASE_URL、ZCODE_MODEL。");
    assert.ok(cases.length >= 6, `examples/zcode.yaml 展开太少: ${cases.length}`);
  });

  const home = mkdtempSync(join(tmpdir(), "ac-e2e-home-"));
  writeFileSync(
    join(home, ".env"),
    [`ZCODE_API_KEY=${creds.key ?? ""}`, `ZCODE_BASE_URL=${creds.baseUrl ?? ""}`, `ZCODE_MODEL=${creds.model}`].join("\n"),
  );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ZCODE_API_KEY: creds.key ?? "",
    ZCODE_BASE_URL: creds.baseUrl ?? "",
    ZCODE_MODEL: creds.model,
    OPENAI_API_KEY: creds.key ?? "",
    OPENAI_BASE_URL: creds.baseUrl ?? "",
  };

  for (const item of cases) {
    it(item.name, { timeout: 240_000 }, () => {
      assert.ok(bin, "AGENTCHAOS_BIN missing");
      const run = spawnSync(bin, item.args, {
        cwd: home,
        env,
        stdio: "inherit",
        timeout: 210_000,
      });
      const report = latestCaseReport(home);
      assert.ok(report, `${item.name}: 没有报告 (exit ${run.status})`);
      const failed = (report.checks ?? [])
        .filter((c) => c.passed === false)
        .map((c) => c.assertion)
        .join(", ");
      assert.equal(report.passed, true, `${item.name} 未通过: ${failed || "unknown"}`);
      assert.equal(run.status, 0, `${item.name} 退出码 ${run.status}`);
    });
  }
});

type Case = { name: string; args: string[] };

function listCases(agentchaos: string): Case[] {
  const spec = join(packageRoot(agentchaos), "examples/zcode.yaml");
  const dry = spawnSync(agentchaos, ["run", spec, "--dry-run"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  const plan = JSON.parse(extractJson(dry.stdout)) as { experiments?: { name: string; file: string }[] };
  const experiments = plan.experiments ?? [];
  return experiments.map((exp) => ({ name: exp.name, args: runArgs(exp.file) }));
}

function runArgs(file: string): string[] {
  const sep = " × ";
  const at = file.indexOf(sep);
  if (at >= 0) {
    return ["run", "--workload", file.slice(0, at), "--profile", file.slice(at + sep.length)];
  }
  return ["run", file];
}

function packageRoot(agentchaos: string): string {
  const real = realpathSync(agentchaos);
  const dir = dirname(real);
  return basename(dir) === "bin" ? dirname(dir) : dir;
}

function which(cmd: string): string | undefined {
  const found = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return found.stdout?.trim().split(/\r?\n/).find((line) => line && existsSync(line));
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, `dry-run 不是 JSON:\n${text.slice(-500)}`);
  return text.slice(start, end + 1);
}

function latestCaseReport(home: string): { passed?: boolean; checks?: { assertion?: string; passed?: boolean }[] } | undefined {
  const runs = join(home, ".agentchaos-runs");
  if (!existsSync(runs)) return undefined;
  const files = readdirSync(runs)
    .filter((name) => !name.startsWith("suite-"))
    .map((id) => join(runs, id, "report.json"))
    .filter((file) => existsSync(file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files[0]) return undefined;
  return JSON.parse(readFileSync(files[0], "utf8")) as {
    passed?: boolean;
    checks?: { assertion?: string; passed?: boolean }[];
  };
}

function loadDotenv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] == null || process.env[match[1]] === "") process.env[match[1]] = value;
  }
}

function firstEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}
