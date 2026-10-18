import test from "node:test";
import assert from "node:assert/strict";
import { settingsFixture } from "./fixtures/investigation-settings.js";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import { investigationSettingsSchema } from "../src/contracts/investigation-settings.js";
import type { InvestigationSettingsTransaction } from "../src/application/investigation-settings/ports.js";
test("model settings derive scope, revision and timestamps and audit without endpoint or credentials", async () => {
  const f = await settingsFixture();
  const value = await f.useCases.create(f.actor, f.input);
  assert.equal(value.enabled, false);
  assert.deepEqual(value.profile.scope, f.scope);
  assert.equal(value.profile.revision, 1);
  assert.equal(value.createdAt, f.now);
  assert.deepEqual(await f.useCases.get(f.actor, f.scope), value);
  const audits = await f.foundation.transaction(f.scope.workspaceId, (tx) =>
    tx.audit.list({ limit: 10 }),
  );
  assert.deepEqual(audits.items[0].metadata, {
    revision: 1,
    enabled: false,
    sourceCount: 1,
  });
  assert.ok(!JSON.stringify(audits).includes(f.input.endpoint));
});
test("viewers and responders may read but cannot create or update model settings", async () => {
  const f = await settingsFixture();
  const value = await f.useCases.create(f.actor, f.input);
  for (const role of ["viewer", "responder"] as const) {
    const actor = { ...f.actor, role };
    assert.deepEqual(await f.useCases.get(actor, f.scope), value);
    await assert.rejects(f.useCases.create(actor, f.input), {
      code: "forbidden",
    });
    await assert.rejects(f.useCases.update(actor, f.update(value)), {
      code: "forbidden",
    });
  }
});
test("foreign workspace settings cannot be read, updated or moved", async () => {
  const f = await settingsFixture();
  const value = await f.useCases.create(f.actor, f.input);
  const actor = {
    ...f.actor,
    workspaceId: workspaceIdSchema.parse("workspace_b"),
  };
  assert.equal(await f.useCases.get(actor, f.scope), undefined);
  await assert.rejects(f.useCases.update(actor, f.update(value)), {
    code: "not_found",
  });
  await assert.rejects(
    f.repository.transaction(actor.workspaceId, (tx) =>
      tx.investigationSettings.save(actor, value, null),
    ),
    { code: "scope_violation" },
  );
});
test("one selected model per service and environment, including concurrent creates", async () => {
  const f = await settingsFixture();
  const outcomes = await Promise.allSettled([
    f.useCases.create(f.actor, f.input),
    f.useCases.create(f.actor, f.input),
  ]);
  assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((v) => v.status === "rejected").length, 1);
});
test("revision compare and swap rejects a concurrent stale edit", async () => {
  const f = await settingsFixture();
  const value = await f.useCases.create(f.actor, f.input);
  const edits = await Promise.allSettled([
    f.useCases.update(f.actor, { ...f.update(value), enabled: true }),
    f.useCases.update(f.actor, { ...f.update(value), enabled: true }),
  ]);
  assert.equal(edits.filter((v) => v.status === "fulfilled").length, 1);
  assert.equal((await f.useCases.get(f.actor, f.scope))?.profile.revision, 2);
});
test("unowned sources and secrets cannot be bound even to a disabled configuration", async () => {
  for (const denied of ["sources", "secret"] as const) {
    const f = await settingsFixture();
    f.policy[denied] = false;
    await assert.rejects(
      f.useCases.create(f.actor, { ...f.input, secretId: "key_a" }),
      { code: "not_found" },
    );
    assert.equal(await f.useCases.get(f.actor, f.scope), undefined);
  }
});
test("revoked bindings can be disabled but cannot be silently changed or enabled", async () => {
  const f = await settingsFixture();
  const value = await f.useCases.create(f.actor, {
    ...f.input,
    enabled: true,
    secretId: "key_a",
  });
  f.policy.sources = false;
  f.policy.secret = false;
  const disabled = await f.useCases.update(f.actor, {
    ...f.update(value),
    enabled: false,
  });
  assert.equal(disabled.enabled, false);
  await assert.rejects(
    f.useCases.update(f.actor, { ...f.update(disabled), enabled: true }),
    { code: "not_found" },
  );
  await assert.rejects(
    f.useCases.update(f.actor, { ...f.update(disabled), sources: [] }),
    { code: "not_found" },
  );
});
test("local secretless model never requests a secret and configuration is detached", async () => {
  const f = await settingsFixture();
  const value = await f.useCases.create(f.actor, f.input);
  assert.equal(f.policy.secretChecks, 0);
  value.sources.length = 0;
  assert.equal((await f.useCases.get(f.actor, f.scope))?.sources.length, 1);
});
test("strict model inputs reject injected identity, raw queries and fallback configuration", async () => {
  const f = await settingsFixture();
  for (const extra of [
    { workspaceId: "other" },
    { id: "chosen" },
    { fallback: "remote" },
    { key: "secret" },
  ])
    await assert.rejects(f.useCases.create(f.actor, { ...f.input, ...extra }));
  await assert.rejects(
    f.useCases.create(f.actor, {
      ...f.input,
      sources: [{ ...f.input.sources[0], query: "SELECT secret" }],
    } as unknown as typeof f.input),
  );
  await assert.rejects(
    f.useCases.create(f.actor, {
      ...f.input,
      endpoint: "https://other.example",
    }),
  );
  assert.equal(await f.useCases.get(f.actor, f.scope), undefined);
});
test("source selections are bounded and unique and model settings require a valid scope", async () => {
  const f = await settingsFixture();
  for (const sources of [
    [f.input.sources[0], f.input.sources[0]],
    [{ ...f.input.sources[0], lookbackMs: 86400001 }],
    [{ ...f.input.sources[0], limit: 101 }],
  ])
    await assert.rejects(f.useCases.create(f.actor, { ...f.input, sources }));
  await assert.rejects(
    f.useCases.create(f.actor, {
      ...f.input,
      serviceId: "missing" as typeof f.input.serviceId,
    }),
    { code: "not_found" },
  );
});
test("an audit failure rolls the selected profile and source links back", async () => {
  const f = await settingsFixture();
  f.policy.failAudit = true;
  await assert.rejects(
    f.useCases.create(f.actor, f.input),
    /Audit unavailable/,
  );
  assert.equal(await f.useCases.get(f.actor, f.scope), undefined);
});
test("invalid direct writes poison the transaction even when caught and escaped handles expire", async () => {
  const f = await settingsFixture();
  const value = await f.useCases.create(f.actor, f.input);
  let escaped: InvestigationSettingsTransaction | undefined;
  await assert.rejects(
    f.repository.transaction(f.scope.workspaceId, async (tx) => {
      escaped = tx;
      try {
        await tx.investigationSettings.save(
          f.actor,
          { ...value, updatedAt: "2020-01-01T00:00:00.000Z" },
          1,
        );
      } catch {
        /* Deliberately caught; transaction must remain poisoned. */
      }
    }),
  );
  await assert.rejects(escaped!.investigationSettings.get(value.profile.id), {
    code: "closed_transaction",
  });
  assert.deepEqual(await f.useCases.get(f.actor, f.scope), value);
});
test("settings reject invalid chronological dates and hosted models without an explicit secret", async () => {
  const f = await settingsFixture();
  const value = await f.useCases.create(f.actor, f.input);
  assert.equal(
    investigationSettingsSchema.safeParse({
      ...value,
      updatedAt: "2020-01-01T00:00:00.000Z",
    }).success,
    false,
  );
  await assert.rejects(
    f.useCases.create(f.actor, {
      ...f.input,
      destination: { ...f.input.destination, provider: "openai" },
    }),
  );
});
