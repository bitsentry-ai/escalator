import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const require = createRequire(
  new URL("../packages/features/package.json", import.meta.url),
);
const root = new URL("../packages/features/", import.meta.url);
for (const name of [
  "contracts",
  "application",
  "channels",
  "investigation",
  "ui",
  "locales",
]) {
  test(`${name} has usable CommonJS and ESM exports`, async () => {
    const cjs = require(`@bitsentry-escalator/features/${name}`);
    const esm = await import(new URL(`dist/esm/${name}/index.js`, root));
    assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
    if (name === "application")
      assert.deepEqual(
        cjs.getEscalatorPackageInfo(),
        esm.getEscalatorPackageInfo(),
      );
    if (name === "locales")
      assert.deepEqual(cjs.escalatorResources, esm.escalatorResources);
  });
}
for (const name of ["application", "channels", "investigation"]) {
  test(`browser bundler rejects server export ${name}`, async () => {
    await assert.rejects(
      build({
        stdin: {
          contents: [
            "im",
            "port ",
            JSON.stringify(`@bitsentry-escalator/features/${name}`),
            ";",
          ].join(""),
          resolveDir: fileURLToPath(new URL("../packages/features", import.meta.url)),
        },
        bundle: true,
        platform: "browser",
        write: false,
        logLevel: "silent",
      }),
    );
  });
}
test("private source subpaths are inaccessible", () => {
  assert.throws(
    () =>
      require.resolve("@bitsentry-escalator/features/src/contracts/index.ts"),
    { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
  );
});

test("registered locale resources include every canonical bundle", () => {
  const {
    escalatorResources,
  } = require("@bitsentry-escalator/features/locales");
  const locales = ["en-US", "en-GB", "en-AU", "fr-FR", "zh-CN", "id-ID"];
  assert.deepEqual(Object.keys(escalatorResources).sort(), locales.sort());
  for (const locale of locales) {
    assert.deepEqual(
      escalatorResources[locale].escalator,
      JSON.parse(
        readFileSync(
          new URL(`src/locales/${locale}/escalator.json`, root),
          "utf8",
        ),
      ),
    );
  }
});
