import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.AGENTCHAOS_SKIP_HELPER === "1") process.exit(0);
if (existsSync(resolve(root, ".git"))) process.exit(0);

const script = resolve(root, "scripts/ensure-helper.mjs");
const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
process.exit(result.status ?? 1);
