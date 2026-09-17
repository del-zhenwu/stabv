import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Platforms the npm tarball must contain. Missing one = do not publish. */
const PACKAGED_HELPERS = [
  { key: "darwin-arm64", exe: "agentchaos-helper" },
  { key: "darwin-x64", exe: "agentchaos-helper" },
  { key: "win32-x64", exe: "agentchaos-helper.exe" },
];

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function exeName() {
  return process.platform === "win32" ? "agentchaos-helper.exe" : "agentchaos-helper";
}

function bundledPath(key = platformKey(), exe = exeName()) {
  return join(root, "prebuilt", key, exe);
}

function isSourceTree() {
  return existsSync(join(root, ".git"));
}

function markExecutable(path) {
  if (process.platform !== "win32") chmodSync(path, 0o755);
}

function useIfPresent(path) {
  if (!existsSync(path)) return false;
  markExecutable(path);
  console.log(`agentchaos: helper ${path}`);
  return true;
}

function missingPackaged() {
  return PACKAGED_HELPERS.filter((item) => !existsSync(bundledPath(item.key, item.exe)));
}

function checkPack() {
  const missing = missingPackaged();
  if (missing.length) {
    console.error(
      `安装包不完整，缺 helper：${missing.map((item) => item.key).join(", ")}。这是发包装错误，不能发给用户，也不能让用户装 Rust 来补。`,
    );
    process.exit(1);
  }
  console.log(`pack helpers ok: ${PACKAGED_HELPERS.map((item) => item.key).join(", ")}`);
}

function buildFromSource() {
  const cargo = spawnSync("cargo", ["build", "-p", "agentchaos-helper", "--release"], {
    cwd: root,
    stdio: "inherit",
  });
  if (cargo.error || cargo.status !== 0) return false;
  const built = join(root, "target/release", exeName());
  if (!existsSync(built)) return false;
  const dest = bundledPath();
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(built, dest);
  markExecutable(dest);
  console.log(`agentchaos: built helper ${dest} (source tree only)`);
  return true;
}

function packageMissingMessage() {
  const need = PACKAGED_HELPERS.map((item) => item.key).join(", ");
  return `安装包缺了 ${platformKey()} 的 helper。这是包装问题，不是用户环境问题。完整包必须带：${need}。`;
}

function main() {
  if (process.argv.includes("--check-pack")) {
    checkPack();
    return;
  }

  if (useIfPresent(bundledPath())) return;

  if (isSourceTree() && process.argv.includes("--build") && buildFromSource()) return;
  if (isSourceTree() && useIfPresent(join(root, "target/release", exeName()))) return;
  if (isSourceTree() && useIfPresent(join(root, "target/debug", exeName()))) return;

  if (isSourceTree()) {
    console.error(`源码树里没有 ${platformKey()} 的 helper。开发机执行：cargo build -p agentchaos-helper --release`);
    process.exit(1);
  }

  console.error(packageMissingMessage());
  process.exit(1);
}

main();
