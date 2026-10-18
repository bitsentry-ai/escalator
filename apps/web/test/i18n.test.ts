import test from "node:test";
import assert from "node:assert/strict";
import { createInstance } from "i18next";
import { escalatorResources } from "@bitsentry-escalator/features/locales";

test("regional English keeps its spelling and falls back to en-US for omitted keys", async () => {
  for (const lng of ["en-AU", "en-GB"]) {
    const i18n = createInstance();
    await i18n.init({
      resources: escalatorResources,
      lng,
      fallbackLng: "en-US",
      defaultNS: "escalator",
    });
    assert.equal(
      i18n.t("services.unavailable"),
      "Escalator is not enabled for this organisation.",
    );
    assert.equal(
      i18n.t("services.title"),
      escalatorResources["en-US"].escalator.services.title,
    );
  }
});
