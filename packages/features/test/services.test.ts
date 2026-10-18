import test from "node:test";
import assert from "node:assert/strict";
import { ServiceUseCases } from "../src/application/services/services.use-cases.js";
import { MemoryFoundationRepository } from "./conformance/memory.js";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
} from "../src/contracts/index.js";
import type { FoundationRepository } from "../src/application/ports/persistence.js";
const now = "2026-09-19T00:00:00.000Z";
async function fixture() {
  const repository = new MemoryFoundationRepository({
    now: () => new Date(now),
  });
  const scope = workspaceIdSchema.parse("workspace-a");
  await repository.transaction(scope, (tx) =>
    tx.workspace.insert({
      id: scope,
      name: "Fixture",
      createdAt: now,
      updatedAt: now,
    }),
  );
  const actor: Actor = {
    workspaceId: scope,
    responderId: responderIdSchema.parse("owner"),
    role: "administrator",
  };
  let sequence = 0;
  const ids = () => `id-${++sequence}`;
  return {
    repository,
    actor,
    ids,
    services: new ServiceUseCases(repository, ids),
  };
}
const input = { name: "API", key: "api", owningTeam: "Platform" };
test("service creation uses database time and commits an audit event atomically", async () => {
  const f = await fixture();
  const service = await f.services.createService(f.actor, input);
  assert.equal(service.createdAt, now);
  assert.equal(service.workspaceId, f.actor.workspaceId);
  assert.deepEqual((await f.services.listServices(f.actor)).items, [service]);
  const audit = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.audit.list({ limit: 10 }),
  );
  assert.equal(audit.items.length, 1);
  assert.equal(audit.items[0].subjectId, service.id);
  assert.equal(audit.items[0].actor.kind, "responder");
  assert.equal(audit.items[0].action, "service.created");
});
test("viewer and responder cannot create services, while scoped reads remain available", async () => {
  const f = await fixture();
  const service = await f.services.createService(f.actor, input);
  for (const role of ["viewer", "responder"] as const) {
    await assert.rejects(
      f.services.createService({ ...f.actor, role }, input),
      { code: "forbidden" },
    );
    assert.deepEqual(
      await f.services.getService({ ...f.actor, role }, service.id),
      service,
    );
  }
  const other = {
    ...f.actor,
    workspaceId: workspaceIdSchema.parse("workspace-b"),
  };
  await assert.rejects(f.services.getService(other, service.id), {
    code: "not_found",
  });
  assert.deepEqual((await f.services.listServices(other)).items, []);
});
test("service input cannot substitute workspace, identity or enabled state", async () => {
  const f = await fixture();
  for (const extra of [
    { workspaceId: "attacker" },
    { id: "chosen" },
    { enabled: false },
  ])
    await assert.rejects(
      f.services.createService(f.actor, { ...input, ...extra }),
    );
  await assert.rejects(f.services.listServices(f.actor, { limit: 0 }));
  assert.equal((await f.services.listServices(f.actor)).items.length, 0);
});
test("duplicate service keys and audit failure roll back the complete mutation", async () => {
  const f = await fixture();
  await f.services.createService(f.actor, input);
  await assert.rejects(f.services.createService(f.actor, input), {
    code: "already_exists",
  });
  const failing: FoundationRepository = {
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
  await assert.rejects(
    new ServiceUseCases(failing, f.ids).createService(f.actor, {
      ...input,
      key: "other",
    }),
  );
  assert.equal((await f.services.listServices(f.actor)).items.length, 1);
  assert.equal(
    (
      await f.repository.transaction(f.actor.workspaceId, (tx) =>
        tx.audit.list({ limit: 10 }),
      )
    ).items.length,
    1,
  );
});
test("service listing returns bounded stable pages", async () => {
  const f = await fixture();
  await f.services.createService(f.actor, input);
  await f.services.createService(f.actor, { ...input, key: "worker" });
  const first = await f.services.listServices(f.actor, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.next);
  const second = await f.services.listServices(f.actor, {
    limit: 1,
    after: first.next,
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.next, null);
  assert.notEqual(first.items[0].id, second.items[0].id);
});
