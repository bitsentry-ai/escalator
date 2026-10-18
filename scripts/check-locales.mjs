import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../packages/features/src/locales/", import.meta.url);
export function flatten(value, prefix = "") {
  return Object.entries(value).flatMap(([key, child]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [[name, child]] : flatten(child, name);
  });
}
export function checkLocale(source, value, { partial = false } = {}) {
  const expected = Object.fromEntries(flatten(source));
  const actual = Object.fromEntries(flatten(value));
  assert.deepEqual(
    Object.keys(actual).sort(),
    (partial
      ? Object.keys(expected).filter((key) => key in actual)
      : Object.keys(expected)
    ).sort(),
    "Missing or extra locale keys",
  );
  for (const [key, text] of Object.entries(actual)) {
    assert.ok(
      text.trim() && !text.includes("\uFFFD"),
      `Invalid translation: ${key}`,
    );
    const tokens = (str) =>
      [...str.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
        .map((match) => match[1])
        .sort();
    assert.deepEqual(
      tokens(text),
      tokens(expected[key]),
      `Interpolation mismatch: ${key}`,
    );
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = JSON.parse(
    readFileSync(new URL("en-US/escalator.json", root), "utf8"),
  );
  const locales = ["en-US", "en-GB", "en-AU", "fr-FR", "zh-CN", "id-ID"];
  for (const locale of locales) {
    checkLocale(
      source,
      JSON.parse(
        readFileSync(new URL(`${locale}/escalator.json`, root), "utf8"),
      ),
      // Regional English bundles override en-US through both hosts' fallback.
      { partial: locale === "en-GB" || locale === "en-AU" },
    );
  }
  // Literal keys used by the shared screens must exist in the source locale.
  const keys = new Set(flatten(source).map(([key]) => key));
  const ui = new URL("../packages/features/src/ui/", import.meta.url);
  for (const file of readdirSync(ui, { recursive: true }))
    if (/\.tsx?$/.test(file))
      for (const [, key] of readFileSync(new URL(file, ui), "utf8").matchAll(
        /\bt\(\s*"([^"]+)"\s*[,)]/g,
      ))
        assert.ok(keys.has(key), `Missing translation key: ${key} (${file})`);
  assert.deepEqual(
    readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(),
    locales.sort(),
  );
  console.log(
    "Escalator namespace integrity passed for both hosts (six locales).",
  );
}
