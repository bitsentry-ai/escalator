import { readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const server = process.cwd();
if (
  JSON.parse(readFileSync("package.json", "utf8")).name !==
  "@bitsentry-escalator/server"
) {
  throw new Error("Run this harness through the standalone server test script");
}
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const entries = walk("test").filter((file) => file.endsWith(".test.ts"));
if (!entries.length) throw new Error("No standalone server tests found");
rmSync(".test-dist", { recursive: true, force: true });
await build({
  entryPoints: entries,
  outdir: ".test-dist",
  outbase: "test",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  alias: {
    "@escalator-test/coverage": path.resolve(
      server,
      "../../packages/features/test/conformance/coverage.ts",
    ),
    "@escalator-test/deployments": path.resolve(
      server,
      "../../packages/features/test/conformance/deployments.ts",
    ),
    "@escalator-test/retention-maintenance": path.resolve(
      server,
      "../../packages/features/test/conformance/retention-maintenance.ts",
    ),
    "@escalator-test/retention-pruning": path.resolve(
      server,
      "../../packages/features/test/conformance/retention-pruning.ts",
    ),
    "@escalator-test/retention-accounting": path.resolve(
      server,
      "../../packages/features/test/conformance/retention-accounting.ts",
    ),
    "@escalator-test/replay-recording": path.resolve(
      process.cwd(),
      "../../packages/features/test/conformance/replay-recording.ts",
    ),
    "@escalator-test/replay-coverage": path.resolve(
      process.cwd(),
      "../../packages/features/test/conformance/replay-coverage.ts",
    ),
    "@escalator-test/health": path.resolve(
      server,
      "../../packages/features/test/conformance/health.ts",
    ),
    "@escalator-test/metrics": path.resolve(
      server,
      "../../packages/features/test/conformance/metrics.ts",
    ),
    "@escalator-test/heartbeats": path.resolve(
      server,
      "../../packages/features/test/conformance/heartbeats.ts",
    ),
    "@escalator-test/probes": path.resolve(
      server,
      "../../packages/features/test/conformance/probes.ts",
    ),
    "@escalator-test/detection": path.resolve(
      server,
      "../../packages/features/test/conformance/detection.ts",
    ),
    "@escalator-test/signals": path.resolve(
      server,
      "../../packages/features/test/conformance/signals.ts",
    ),
    "@escalator-test/paging-scenarios": path.resolve(
      server,
      "../../packages/features/test/scenarios/paging/scenarios.ts",
    ),
    "@escalator-test/incidents": path.resolve(
      server,
      "../../packages/features/test/conformance/incidents.ts",
    ),
    "@escalator-test/configuration": path.resolve(
      server,
      "../../packages/features/test/conformance/configuration.ts",
    ),
    "@escalator-test/paging": path.resolve(
      server,
      "../../packages/features/test/conformance/paging.ts",
    ),
    "@escalator-test/secrets": path.resolve(
      server,
      "../../packages/features/test/conformance/secrets.ts",
    ),
    "@escalator-test/work": path.resolve(
      server,
      "../../packages/features/test/conformance/work.ts",
    ),
    // Reuse test fixtures only. Production hosts still import compiled exports.
    "@escalator-test/foundation": path.resolve(
      server,
      "../../packages/features/test/conformance/foundation.ts",
    ),
  },
});
const result = spawnSync(
  process.execPath,
  [
    "--test",
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
