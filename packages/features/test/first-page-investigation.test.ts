import test from "node:test";
import assert from "node:assert/strict";
import {
  investigationSettingsSchema,
  operationalIncidentSchema,
} from "../src/contracts/index.js";
import { firstPageInvestigation } from "../src/investigation/orchestration/first-page.js";
import { investigationFixture } from "./fixtures/investigation.js";
import { MemoryPagingRepository } from "./conformance/memory-paging.js";
import { seedPagingFixture } from "./conformance/paging.js";
import { openPageInTransaction } from "../src/application/paging/create-page.js";
import type { PagingTransaction } from "../src/application/paging/persistence.js";
function fixture() {
  const { claim, result } = investigationFixture();
  const { incidentId, ...scope } = claim.scope;
  const incident = operationalIncidentSchema.parse({
    ...scope,
    id: incidentId,
    title: "Outage",
    severity: "critical",
    openedAt: "2026-10-05T12:00:00.000Z",
    resolvedAt: null,
  });
  const settings = investigationSettingsSchema.parse({
    profile: {
      id: claim.profileId,
      revision: 1,
      scope,
      destination: result.report.destination,
      endpoint: "http://127.0.0.1:11434",
      secretId: null,
    },
    enabled: true,
    limits: claim.limits,
    sources: [
      { kind: "alert", sourceId: "source_a", lookbackMs: 60000, limit: 3 },
    ],
    createdAt: incident.openedAt,
    updatedAt: incident.openedAt,
  });
  return { incident, settings };
}
test("first page captures bounded windows from incident time and detaches settings", () => {
  const { incident, settings } = fixture();
  const intent = firstPageInvestigation(incident, settings)!;
  assert.deepEqual(intent.sources[0], {
    kind: "alert",
    sourceId: "source_a",
    limit: 3,
    window: { from: "2026-10-05T11:59:00.000Z", to: incident.openedAt },
  });
  settings.limits.maxOutputTokens = 256;
  settings.sources[0].limit = 99;
  assert.equal(intent.limits.maxOutputTokens, 128);
  assert.equal(intent.sources[0].limit, 3);
});
test("first-page id is stable across configuration edits and isolated by workspace", () => {
  const { incident, settings } = fixture();
  const before = firstPageInvestigation(incident, settings)!;
  settings.profile.revision++;
  assert.equal(firstPageInvestigation(incident, settings)!.id, before.id);
  const other = fixture();
  other.incident.workspaceId = other.settings.profile.scope.workspaceId =
    operationalIncidentSchema.shape.workspaceId.parse("other");
  assert.notEqual(
    firstPageInvestigation(other.incident, other.settings)!.id,
    before.id,
  );
  assert.match(before.id, /^[a-f0-9]{64}$/);
  assert.equal(before.id, before.idempotencyKey);
});
test("absent or disabled configuration schedules nothing", () => {
  const { incident, settings } = fixture();
  assert.equal(firstPageInvestigation(incident, undefined), undefined);
  settings.enabled = false;
  assert.equal(firstPageInvestigation(incident, settings), undefined);
});
test("foreign settings and resolved incidents cannot create intents", () => {
  for (const key of ["workspaceId", "serviceId", "environmentId"] as const) {
    const { incident, settings } = fixture();
    assert.throws(() =>
      firstPageInvestigation(incident, {
        ...settings,
        profile: {
          ...settings.profile,
          scope: { ...settings.profile.scope, [key]: "other" },
        },
      }),
    );
  }
  const { incident, settings } = fixture();
  assert.throws(() =>
    firstPageInvestigation(
      { ...incident, resolvedAt: incident.openedAt },
      settings,
    ),
  );
});
async function input(tx: PagingTransaction) {
  const seed = (await tx.pages.get("page"))!;
  return {
    incident: {
      id: "new_incident",
      serviceId: seed.policy.serviceId,
      environmentId: fixture().incident.environmentId,
      title: "New outage",
      severity: "critical" as const,
    },
    policy: seed.policy,
  };
}
test("first-page handoff runs once, with the trusted incident in the same transaction", async () => {
  const { incident } = fixture();
  let calls = 0;
  const repo = new MemoryPagingRepository(
    { now: () => new Date(incident.openedAt) },
    async (value, tx) => {
      calls++;
      assert.equal(value.id, "new_incident");
      assert.equal(value.workspaceId, tx.workspaceId);
      await tx.work.enqueue("job", {
        id: "investigation",
        kind: "investigation.run",
        idempotencyKey: "investigation",
        payload: { incidentId: value.id },
        dueAt: tx.now,
      });
    },
  );
  await repo.transaction(incident.workspaceId, seedPagingFixture);
  await repo.transaction(incident.workspaceId, async (tx) => {
    const request = await input(tx);
    const page = await openPageInTransaction(tx, request);
    assert.equal((await openPageInTransaction(tx, request)).id, page.id);
  });
  assert.equal(calls, 1);
  const lease = await repo.foundation.claim({
    workspaceId: incident.workspaceId,
    queue: "job",
    token: "claim",
    leaseMs: 10000,
    kinds: ["investigation.run"],
  });
  assert.equal(lease?.payload.incidentId, "new_incident");
});
test("caught handoff failures still roll back incident, page and durable work", async () => {
  const { incident } = fixture();
  const repo = new MemoryPagingRepository(
    { now: () => new Date(incident.openedAt) },
    async (_value, tx) => {
      await tx.work.enqueue("job", {
        id: "investigation",
        kind: "investigation.run",
        idempotencyKey: "investigation",
        payload: {},
        dueAt: tx.now,
      });
      throw new Error("enqueue failed");
    },
  );
  await repo.transaction(incident.workspaceId, seedPagingFixture);
  await assert.rejects(
    repo.transaction(incident.workspaceId, async (tx) => {
      try {
        await openPageInTransaction(tx, await input(tx));
      } catch {
        /* verify poisoned transaction */
      }
    }),
  );
  await repo.transaction(incident.workspaceId, async (tx) =>
    assert.equal(await tx.incidents.get("new_incident"), undefined),
  );
  assert.equal(
    await repo.foundation.claim({
      workspaceId: incident.workspaceId,
      queue: "job",
      token: "claim",
      leaseMs: 10000,
      kinds: ["investigation.run"],
    }),
    undefined,
  );
});
test("handoff cannot escape the transaction or accept a missing page", async () => {
  const { incident } = fixture();
  let escaped: PagingTransaction["investigations"];
  const repo = new MemoryPagingRepository(
    { now: () => new Date(incident.openedAt) },
    async () => {},
  );
  await repo.transaction(incident.workspaceId, seedPagingFixture);
  await repo.transaction(incident.workspaceId, async (tx) => {
    escaped = tx.investigations;
  });
  await assert.rejects(() => escaped!.enqueueForPage("page"));
  await assert.rejects(
    repo.transaction(incident.workspaceId, (tx) =>
      tx.investigations!.enqueueForPage("missing"),
    ),
  );
});
