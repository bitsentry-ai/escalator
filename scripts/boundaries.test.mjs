import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkSource, walk } from "./check-boundaries.mjs";
import { checkLocale } from "./check-locales.mjs";
for (const source of [
  'import "../channels/index.js";',
  'export * from "../investigation/index.js";',
  'import "@bitsentry-escalator/features/investigation";',
  'const x = import("node:fs");',
  'const x = require("../channels/index.js");',
  "const x = import(destination);",
  'import "../../../../backend/auth.js";',
]) {
  test(`browser boundary rejects ${source}`, () =>
    assert.ok(checkSource("/src/ui/index.ts", source, "/src").length));
}
test("browser boundary allows contracts", () =>
  assert.deepEqual(
    checkSource(
      "/src/ui/client.ts",
      'import type { Info } from "../contracts/index.js";',
      "/src",
    ),
    [],
  ));
test("contracts cannot transitively import server code", () =>
  assert.ok(
    checkSource(
      "/src/contracts/index.ts",
      'export * from "../application/index.js";',
      "/src",
    ).length,
  ));
test("locale gate rejects missing keys and changed interpolation", () => {
  assert.throws(() => checkLocale({ title: "Title" }, {}));
  assert.throws(() =>
    checkLocale({ title: "{{name}}" }, { title: "{{other}}" }),
  );
});

test("contracts cannot pull React or UI into a server consumer", () => {
  assert.ok(
    checkSource("/src/contracts/index.ts", 'import "react";', "/src").length,
  );
  assert.ok(
    checkSource(
      "/src/contracts/index.ts",
      'export * from "../ui/index.js";',
      "/src",
    ).length,
  );
});

test("boundary walker scans every TypeScript module extension", () => {
  const root = mkdtempSync(path.join(tmpdir(), "escalator-walk-"));
  try {
    mkdirSync(path.join(root, "ui"));
    for (const name of ["a.ts", "b.tsx", "c.mts", "d.cts", "e.json"])
      writeFileSync(path.join(root, "ui", name), "");
    assert.deepEqual(
      walk(root)
        .map((file) => path.basename(file))
        .sort(),
      ["a.ts", "b.tsx", "c.mts", "d.cts"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
