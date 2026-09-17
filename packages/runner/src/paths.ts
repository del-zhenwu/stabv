import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function isPackageRoot(dir: string): boolean {
  if (existsSync(resolve(dir, "packages/runner")) && existsSync(resolve(dir, "helper"))) return true;
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { name?: string };
    return pkg.name === "agentchaos";
  } catch {
    return false;
  }
}

export function repoRoot(): string {
  if (process.env.AGENTCHAOS_ROOT) return resolve(process.env.AGENTCHAOS_ROOT);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (isPackageRoot(dir)) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}
