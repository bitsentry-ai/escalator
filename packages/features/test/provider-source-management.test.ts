import test from "node:test";
import assert from "node:assert/strict";
import { SignalManagement } from "../src/application/signals/management.js";
import { signalTokenDigest } from "../src/application/signals/ingest.js";
import { MemorySignalRepository } from "./conformance/memory-signals.js";
import { seedSignalFixture } from "./conformance/signals.js";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
} from "../src/contracts/index.js";
function sourceKindFor(mode: string): "sentry" | "glitchtip" | "grafana" {
  if (mode.startsWith("sentry")) return "sentry";
  if (mode === "glitchtip") return "glitchtip";
  return "grafana";
}
async function fixture() {
  const repository = new MemorySignalRepository();
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("workspace"),
    responderId: responderIdSchema.parse("owner"),
    role: "administrator",
  };
  await repository.transaction(actor.workspaceId, seedSignalFixture);
  let n = 0;
  return {
    repository,
    actor,
    cases: new SignalManagement(repository, () => `provider-${++n}`),
  };
}
const fields = {
  name: "Tracker",
  serviceId: "service",
  environmentId: "production",
};
test("provider sources derive kind, scope and recovery from their validated configuration", async () => {
  const f = await fixture();
  for (const mode of [
    "sentry-hmac",
    "glitchtip",
    "grafana-bearer",
    "grafana-hmac",
  ] as const) {
    const intake =
      mode === "glitchtip"
        ? { mode, trackerOrigin: "https://errors.example.invalid" }
        : { mode };
    const source = await f.cases.createProvider(f.actor, {
      ...fields,
      intake,
      authSecretId: mode.endsWith("hmac") ? "fixture-secret" : null,
    });
    assert.equal(source.kind, sourceKindFor(mode));
    assert.equal(source.workspaceId, f.actor.workspaceId);
    assert.equal(
      source.recovery,
      source.kind === "grafana" ? "explicit" : "manual",
    );
  }
});
test("signed sources issue public routing references but never bearer grants", async () => {
  const f = await fixture();
  const source = await f.cases.createProvider(f.actor, {
    ...fields,
    intake: { mode: "sentry-hmac" },
    authSecretId: "fixture-secret",
  });
  await assert.rejects(f.cases.issueToken(f.actor, { sourceId: source.id }), {
    code: "source_kind",
  });
  const receiver = await f.cases.issueReceiver(f.actor, {
    sourceId: source.id,
  });
  assert.match(receiver.receiverId, /^[a-f0-9]{64}$/);
  assert.equal("token" in receiver, false);
  assert.equal(signalTokenDigest(receiver.receiverId), undefined);
  const persisted = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.tokens.getByHash(receiver.receiverId),
  );
  assert.equal(persisted?.id, receiver.id);
  await f.cases.revokeToken(f.actor, { id: receiver.id });
  assert.notEqual(
    (
      await f.repository.transaction(f.actor.workspaceId, (tx) =>
        tx.tokens.getByHash(receiver.receiverId),
      )
    )?.revokedAt,
    null,
  );
});
test("token-only provider modes cannot obtain signed receivers or accept secret bindings", async () => {
  const f = await fixture();
  const source = await f.cases.createProvider(f.actor, {
    ...fields,
    intake: { mode: "grafana-bearer" },
    authSecretId: null,
  });
  assert.match(
    (await f.cases.issueToken(f.actor, { sourceId: source.id })).token,
    /^esi_/,
  );
  await assert.rejects(
    f.cases.issueReceiver(f.actor, { sourceId: source.id }),
    { code: "source_kind" },
  );
  await assert.rejects(
    f.cases.createProvider(f.actor, {
      ...fields,
      intake: { mode: "grafana-bearer" },
      authSecretId: "fixture-secret",
    }),
  );
  await assert.rejects(
    f.cases.createProvider(f.actor, {
      ...fields,
      intake: { mode: "sentry-hmac" },
      authSecretId: null,
    }),
  );
  await assert.rejects(
    f.cases.createProvider(f.actor, {
      ...fields,
      intake: { mode: "sentry-hmac" },
      authSecretId: "unowned",
    }),
    { code: "not_found" },
  );
});
test("active-only providers cannot be switched to automatic recovery through generic editing", async () => {
  const f = await fixture();
  const source = await f.cases.createProvider(f.actor, {
    ...fields,
    intake: {
      mode: "glitchtip",
      trackerOrigin: "https://errors.example.invalid",
    },
    authSecretId: null,
  });
  await assert.rejects(
    f.cases.update(f.actor, {
      id: source.id,
      expectedVersion: 1,
      name: source.name,
      enabled: true,
      grouping: source.grouping,
      recovery: "explicit",
      recoveryHoldSeconds: 60,
    }),
    { code: "invalid_configuration" },
  );
  assert.equal(
    (await f.cases.get(f.actor, { id: source.id })).recovery,
    "manual",
  );
});
test("credential changes preserve source kind and use optimistic versions", async () => {
  const f = await fixture();
  const source = await f.cases.createProvider(f.actor, {
    ...fields,
    intake: { mode: "grafana-bearer" },
    authSecretId: null,
  });
  const input = {
    id: source.id,
    expectedVersion: 1,
    intake: { mode: "grafana-hmac" as const },
    authSecretId: "fixture-secret",
  };
  assert.equal((await f.cases.updateProvider(f.actor, input)).version, 2);
  await assert.rejects(f.cases.updateProvider(f.actor, input), {
    code: "conflict",
  });
  await assert.rejects(
    f.cases.updateProvider(f.actor, {
      ...input,
      expectedVersion: 2,
      intake: { mode: "sentry-hmac" },
    }),
    { code: "source_kind" },
  );
  await assert.rejects(
    f.cases.updateProvider(
      { ...f.actor, role: "viewer" },
      { ...input, expectedVersion: 2 },
    ),
    { code: "forbidden" },
  );
  await assert.rejects(
    f.cases.updateProvider(
      { ...f.actor, workspaceId: workspaceIdSchema.parse("foreign") },
      { ...input, expectedVersion: 2 },
    ),
    { code: "not_found" },
  );
});
test("provider configuration rejects request scope and credential-bearing tracker URLs", async () => {
  const f = await fixture();
  for (const trackerOrigin of [
    "https://user:secret@errors.example.invalid",
    "https://errors.example.invalid/path",
    "https://errors.example.invalid?token=secret",
    "file:///tmp/tracker",
  ])
    await assert.rejects(
      f.cases.createProvider(f.actor, {
        ...fields,
        intake: { mode: "glitchtip", trackerOrigin },
        authSecretId: null,
      }),
    );
  await assert.rejects(
    f.cases.createProvider(f.actor, {
      ...fields,
      intake: { mode: "grafana-bearer" },
      authSecretId: null,
      workspaceId: "foreign",
    } as never),
  );
  await assert.rejects(
    f.cases.createProvider(
      { ...f.actor, role: "responder" },
      { ...fields, intake: { mode: "grafana-bearer" }, authSecretId: null },
    ),
    { code: "forbidden" },
  );
});

test("provider creation and credential updates roll back when their audit cannot commit", async () => {
  const f = await fixture();
  const source = await f.cases.createProvider(f.actor, {
    ...fields,
    intake: { mode: "grafana-bearer" },
    authSecretId: null,
  });
  const failing = new SignalManagement(
    {
      findTokenContext: (hash) => f.repository.findTokenContext(hash),
      transaction: (scope, work) =>
        f.repository.transaction(scope, (tx) =>
          work({
            ...tx,
            audit: {
              ...tx.audit,
              append: async () => {
                throw new Error("audit unavailable");
              },
            },
          }),
        ),
    },
    () => "failed-operation",
  );
  await assert.rejects(
    failing.createProvider(f.actor, {
      ...fields,
      intake: { mode: "sentry-hmac" },
      authSecretId: "fixture-secret",
    }),
    /audit unavailable/,
  );
  assert.equal((await f.cases.list(f.actor)).items.length, 2);
  await assert.rejects(
    failing.updateProvider(f.actor, {
      id: source.id,
      expectedVersion: 1,
      intake: { mode: "grafana-hmac" },
      authSecretId: "fixture-secret",
    }),
    /audit unavailable/,
  );
  const unchanged = await f.cases.get(f.actor, { id: source.id });
  assert.equal(unchanged.version, 1);
  assert.equal(unchanged.intake?.mode, "grafana-bearer");
});

test("verification secret metadata is bound to the live source version, scope and transaction", async () => {
  const f = await fixture();
  const source = await f.cases.createProvider(f.actor, {
    ...fields,
    intake: { mode: "sentry-hmac" },
    authSecretId: "fixture-secret",
  });
  const sources = await f.repository.transaction(
    f.actor.workspaceId,
    async (tx) => {
      assert.equal(await tx.sources.hasUsableSecret(source.id, 1), true);
      assert.equal(await tx.sources.hasUsableSecret(source.id, 2), false);
      assert.equal(await tx.sources.hasUsableSecret("missing", 1), false);
      return tx.sources;
    },
  );
  await assert.rejects(sources.hasUsableSecret(source.id, 1));
  await f.repository.transaction(
    workspaceIdSchema.parse("foreign"),
    async (tx) => {
      assert.equal(await tx.sources.hasUsableSecret(source.id, 1), false);
    },
  );
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    await tx.sources.replace(
      { ...source, enabled: false, version: 2, updatedAt: tx.now },
      1,
    );
    assert.equal(await tx.sources.hasUsableSecret(source.id, 2), false);
  });
  const unsigned = await f.cases.createProvider(f.actor, {
    ...fields,
    intake: { mode: "grafana-bearer" },
    authSecretId: null,
  });
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    assert.equal(await tx.sources.hasUsableSecret(unsigned.id, 1), false);
  });
});
