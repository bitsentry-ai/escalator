import test from "node:test";
import assert from "node:assert/strict";
import { SignalManagement } from "../src/application/signals/management.js";
import {
  SignalIntake,
  signalTokenDigest,
} from "../src/application/signals/ingest.js";
import type { SignalRepository } from "../src/application/signals/ports.js";
import { MemorySignalRepository } from "./conformance/memory-signals.js";
import { seedSignalFixture } from "./conformance/signals.js";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
} from "../src/contracts/index.js";
const now = "2026-09-20T00:00:00.000Z";
async function fixture() {
  const repository = new MemorySignalRepository();
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("workspace-a"),
    responderId: responderIdSchema.parse("administrator"),
    role: "administrator",
  };
  await repository.transaction(actor.workspaceId, seedSignalFixture);
  let n = 0;
  const ids = () => `created-${++n}`;
  return {
    repository,
    actor,
    ids,
    management: new SignalManagement(repository, ids),
  };
}
const create = {
  name: "API errors",
  serviceId: "service",
  environmentId: "production",
  kind: "generic" as const,
};
const event = {
  version: 1,
  eventId: "first",
  fingerprint: "error",
  status: "active",
  severity: "critical",
  title: "Failed",
  observedAt: now,
  evidence: { summary: "Failure", attributes: [] },
};
const update = {
  id: "source",
  expectedVersion: 1,
  name: "Renamed",
  enabled: false,
  grouping: "source-fingerprint" as const,
  recovery: "explicit" as const,
  recoveryHoldSeconds: 60,
};

test("source creation, optimistic edits and auditing share trusted tenant scope", async () => {
  const f = await fixture();
  const source = await f.management.create(f.actor, create);
  assert.equal(source.workspaceId, f.actor.workspaceId);
  assert.equal(source.createdAt, now);
  assert.equal(source.authSecretId, null);
  assert.equal((await f.management.list(f.actor)).items.length, 2);
  const edited = await f.management.update(f.actor, update);
  assert.equal(edited.version, 2);
  assert.equal(edited.enabled, false);
  await assert.rejects(f.management.update(f.actor, update), {
    code: "conflict",
  });
  const audit = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.audit.list({ limit: 100 }),
  );
  assert.deepEqual(
    audit.items.map((row) => row.action),
    ["signal.source.created", "signal.source.updated"],
  );
});
test("only administrators can change sources or issue and revoke grants", async () => {
  const f = await fixture();
  for (const role of ["viewer", "responder"] as const) {
    const actor = { ...f.actor, role };
    assert.equal(
      (await f.management.get(actor, { id: "source" })).name,
      "Errors",
    );
    await assert.rejects(f.management.create(actor, create), {
      code: "forbidden",
    });
    await assert.rejects(f.management.update(actor, update), {
      code: "forbidden",
    });
    await assert.rejects(
      f.management.issueToken(actor, { sourceId: "source" }),
      { code: "forbidden" },
    );
    await assert.rejects(f.management.revokeToken(actor, { id: "token" }), {
      code: "forbidden",
    });
  }
});
test("foreign IDs and request-selected scope cannot cross the actor boundary", async () => {
  const f = await fixture();
  const foreign = { ...f.actor, workspaceId: workspaceIdSchema.parse("other") };
  await assert.rejects(f.management.get(foreign, { id: "source" }), {
    code: "not_found",
  });
  await assert.rejects(f.management.update(foreign, update), {
    code: "not_found",
  });
  await assert.rejects(
    f.management.issueToken(foreign, { sourceId: "source" }),
    { code: "not_found" },
  );
  await assert.rejects(
    f.management.create(f.actor, {
      ...create,
      workspaceId: "other",
    } as typeof create),
  );
  await assert.rejects(
    f.management.update(f.actor, {
      ...update,
      serviceId: "foreign",
    } as typeof update),
  );
});
test("grant plaintext is returned once, never persisted or audited, and revocation denies intake", async () => {
  const f = await fixture();
  const grant = await f.management.issueToken(f.actor, {
    sourceId: "source",
    ttlSeconds: 60,
  });
  assert.match(grant.token, /^esi_[A-Za-z0-9_-]{43}$/);
  assert.equal(grant.expiresAt, "2026-09-20T00:01:00.000Z");
  const digest = signalTokenDigest(grant.token)!;
  const stored = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.tokens.getByHash(digest),
  );
  assert.equal(stored?.id, grant.id);
  assert.equal(JSON.stringify(stored).includes(grant.token), false);
  const intake = new SignalIntake(f.repository);
  assert.equal(
    (await intake.accept("source", grant.token, event)).state,
    "accepted",
  );
  await f.management.revokeToken(f.actor, { id: grant.id });
  await f.management.revokeToken(f.actor, { id: grant.id });
  await assert.rejects(
    intake.accept("source", grant.token, { ...event, eventId: "second" }),
    { code: "invalid_token" },
  );
  const audit = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.audit.list({ limit: 100 }),
  );
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes(grant.token), false);
  assert.equal(serialized.includes(digest), false);
  await assert.rejects(
    f.management.revokeToken(
      { ...f.actor, workspaceId: workspaceIdSchema.parse("foreign") },
      { id: grant.id },
    ),
    { code: "not_found" },
  );
});
test("disabled sources reject new grants and strict issuance rejects unbounded expiry", async () => {
  const f = await fixture();
  for (const ttlSeconds of [0, 59, 90 * 86400 + 1, Number.POSITIVE_INFINITY])
    await assert.rejects(
      f.management.issueToken(f.actor, { sourceId: "source", ttlSeconds }),
    );
  await f.management.update(f.actor, update);
  await assert.rejects(
    f.management.issueToken(f.actor, { sourceId: "source" }),
    { code: "source_disabled" },
  );
});
test("failed audit rolls back source and token changes without returning credentials", async () => {
  const f = await fixture();
  const failing: SignalRepository = {
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
  };
  const management = new SignalManagement(failing, f.ids);
  await assert.rejects(management.create(f.actor, create), /audit unavailable/);
  assert.equal((await f.management.list(f.actor)).items.length, 1);
  await assert.rejects(management.update(f.actor, update), /audit unavailable/);
  assert.equal(
    (await f.management.get(f.actor, { id: "source" })).enabled,
    true,
  );
  await assert.rejects(
    management.issueToken(f.actor, { sourceId: "source" }),
    /audit unavailable/,
  );
  const audit = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.audit.list({ limit: 100 }),
  );
  assert.equal(audit.items.length, 0);
  const committed = await f.management.issueToken(f.actor, {
    sourceId: "source",
  });
  await assert.rejects(
    management.revokeToken(f.actor, { id: committed.id }),
    /audit unavailable/,
  );
  const grant = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.tokens.getByHash(signalTokenDigest(committed.token)!),
  );
  assert.equal(grant?.revokedAt, null);
  assert.equal(
    (
      await new SignalIntake(f.repository).accept(
        "source",
        committed.token,
        event,
      )
    ).state,
    "accepted",
  );
});

test("rotation keeps the replacement valid and disabling the source blocks all grants", async () => {
  const f = await fixture();
  const old = await f.management.issueToken(f.actor, { sourceId: "source" });
  const replacement = await f.management.issueToken(f.actor, {
    sourceId: "source",
  });
  assert.notEqual(old.token, replacement.token);
  assert.equal(old.expiresAt, "2026-10-20T00:00:00.000Z");
  await f.management.revokeToken(f.actor, { id: old.id });
  const intake = new SignalIntake(f.repository);
  await assert.rejects(intake.accept("source", old.token, event), {
    code: "invalid_token",
  });
  assert.equal(
    (await intake.accept("source", replacement.token, event)).state,
    "accepted",
  );
  await f.management.update(f.actor, update);
  await assert.rejects(
    intake.accept("source", replacement.token, {
      ...event,
      eventId: "disabled",
    }),
    { code: "invalid_token" },
  );
});
