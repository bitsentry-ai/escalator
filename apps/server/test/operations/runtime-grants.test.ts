import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sources(file)
      : file.endsWith(".ts")
        ? [file]
        : [];
  });
}
// PostgreSQL rejects FOR UPDATE/FOR SHARE without UPDATE on at least one column.
test("runtime grants allow every fixed-table locking read the server issues", () => {
  const grants = readFileSync("../../deploy/runtime-grants.sql", "utf8");
  const updatable = new Set<string>();
  for (const [, privileges, tables] of grants.matchAll(
    /GRANT\s+([^;]*?)\s+ON\s+([^;]*?)\s+TO\s/g,
  ))
    if (/\bUPDATE\b/.test(privileges!))
      for (const table of tables!.split(",")) updatable.add(table.trim());
  const locked = new Set<string>();
  for (const file of sources("src"))
    for (const [, table] of readFileSync(file, "utf8").matchAll(
      /FROM (escalator_\w+)\b(?!\$\{)[^`;]{0,300}?\bFOR (?:UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/g,
    ))
      locked.add(table!);
  assert.ok(locked.has("escalator_workspace"));
  assert.ok(locked.has("escalator_environment"));
  assert.deepEqual(
    [...locked].filter((table) => !updatable.has(table)).sort(),
    [],
  );
});
