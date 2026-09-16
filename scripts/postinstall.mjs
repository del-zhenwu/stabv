import { spawnSync } from "node:child_process";

if (process.env.AGENTCHAOS_SKIP_HELPER === "1") process.exit(0);
const result = spawnSync("cargo", ["build", "-p", "agentchaos-helper"], { encoding: "utf8" });
if (result.error || result.status !== 0) {
  console.warn("agentchaos: helper not built automatically. Install Rust (https://rustup.rs) then run:");
  console.warn("  npx agentchaos setup");
  if (result.stderr) console.warn(String(result.stderr).trim().slice(0, 400));
}
