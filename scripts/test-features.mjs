import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const files = walk("test");
const entries = files.filter((file) => file.endsWith(".test.ts"));
rmSync(".test-dist", { recursive: true, force: true });
if (entries.length)
  await build({
    entryPoints: entries,
    outdir: ".test-dist",
    outbase: "test",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    sourcemap: "inline",
  });
const result = spawnSync(
  process.execPath,
  [
    "--test",
    ...files.filter((file) => file.endsWith(".test.mjs")),
    ...entries.map((file) =>
      path
        .join(".test-dist", path.relative("test", file))
        .replace(/\.ts$/, ".cjs"),
    ),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
