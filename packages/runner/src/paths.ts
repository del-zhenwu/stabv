import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function repoRoot(): string {
  if (process.env.AGENTCHAOS_ROOT) return resolve(process.env.AGENTCHAOS_ROOT);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "packages/runner")) && existsSync(resolve(dir, "helper"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return process.cwd();
}
