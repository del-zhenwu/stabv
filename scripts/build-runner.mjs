import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: {
    cli: "packages/runner/src/cli.ts",
    "mcp-stdio": "packages/runner/src/mcp-stdio.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "dist",
  packages: "external",
  logLevel: "info",
});
