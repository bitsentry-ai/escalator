import { readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
const entries = readdirSync("test")
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `test/${name}`);
rmSync(".test-dist", { recursive: true, force: true });
await build({
  entryPoints: entries,
  outdir: ".test-dist",
  outbase: "test",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
});
const result = spawnSync(
  process.execPath,
  [
    "--test",
    ...entries.map((name) =>
      name.replace("test/", ".test-dist/").replace(/\.ts$/, ".mjs"),
    ),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
