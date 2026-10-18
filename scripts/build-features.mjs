import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
rmSync("dist", { recursive: true, force: true });
for (const [format, args] of [
  ["cjs", []],
  ["esm", ["--module", "ES2022", "--moduleResolution", "bundler"]],
]) {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "tsc",
      "-p",
      "tsconfig.json",
      "--outDir",
      `dist/${format}`,
      ...args,
    ],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  mkdirSync(`dist/${format}`, { recursive: true });
  writeFileSync(
    `dist/${format}/package.json`,
    JSON.stringify({ type: format === "esm" ? "module" : "commonjs" }),
  );
}
// Bundle JSON resources into ESM so Node consumers need no JSON import attributes.
await build({
  entryPoints: [
    "contracts",
    "application",
    "channels",
    "investigation",
    "ui",
    "locales",
  ].map((name) => `src/${name}/index.ts`),
  outdir: "dist/esm",
  outbase: "src",
  bundle: true,
  format: "esm",
  platform: "neutral",
  packages: "external",
});
