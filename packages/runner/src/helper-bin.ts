import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** npm 包必须带齐这些 helper。缺一个就不能发。 */
export const PACKAGED_HELPERS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "win32", arch: "x64" },
] as const;

export function helperPlatformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

export function helperExeName(platform = process.platform): string {
  return platform === "win32" ? "agentchaos-helper.exe" : "agentchaos-helper";
}

export function bundledHelperPath(root: string, platform = process.platform, arch = process.arch): string {
  return resolve(root, "prebuilt", helperPlatformKey(platform, arch), helperExeName(platform));
}

export function helperSearchPaths(root: string): string[] {
  const exe = helperExeName();
  return [
    process.env.AGENTCHAOS_HELPER,
    resolve(root, "target/debug", exe),
    resolve(root, "target/release", exe),
    resolve(root, "helper/target/debug", exe),
    resolve(root, "helper/target/release", exe),
    resolve(root, "helper/bin", exe),
    bundledHelperPath(root),
  ].filter((x): x is string => Boolean(x));
}

export function findHelperBin(root: string): string | undefined {
  return helperSearchPaths(root).find((path) => existsSync(path));
}

export function missingPackagedHelpers(root: string): string[] {
  return PACKAGED_HELPERS.filter((item) => !existsSync(bundledHelperPath(root, item.platform, item.arch))).map((item) =>
    helperPlatformKey(item.platform, item.arch),
  );
}
