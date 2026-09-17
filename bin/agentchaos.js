#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundled = resolve(root, "dist/cli.js");
const src = resolve(root, "packages/runner/src/cli.ts");
const args = existsSync(bundled)
  ? [bundled, ...process.argv.slice(2)]
  : ["--experimental-strip-types", src, ...process.argv.slice(2)];
const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
