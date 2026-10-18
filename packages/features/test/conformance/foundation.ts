import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  environmentIdSchema,
  responderIdSchema,
  environmentSchema,
  responderSchema,
  serviceSchema,
  workspaceIdSchema,
  workspaceSchema,
  type WorkspaceId,
} from "../../src/contracts/index.js";
import type { AuditEvent } from "../../src/application/ports/audit.js";
import type {
  FoundationRepository,
  FoundationTransaction,
} from "../../src/application/ports/persistence.js";

export interface FoundationFixture {
  repository: FoundationRepository;
  dispose(): Promise<void>;
}
export type FoundationFactory = () => Promise<FoundationFixture>;
const timestamp = "2026-09-18T00:00:00.000Z";
const dates = { createdAt: timestamp, updatedAt: timestamp };
const service = (workspaceId: WorkspaceId, id = "service_1", key = "api") =>
  serviceSchema.parse({
    id,
    workspaceId,
    name: "API",
    key,
    owningTeam: "Platform",
    enabled: true,
    ...dates,
  });
const event = (workspaceId: WorkspaceId): AuditEvent => ({
  id: "audit_1",
  workspaceId,
  actor: { kind: "system", component: "fixture" },
  action: "service.created",
  subjectType: "service",
  subjectId: "service_1",
  recordedAt: timestamp,
  metadata: { key: "api" },
});

/** The identical assertions run against memory, standalone PG and Dashboard Prisma. */
export function foundationConformance(
  name: string,
  create: FoundationFactory,
): void {
  function scenario(
    title: string,
    run: (
      repo: FoundationRepository,
      a: WorkspaceId,
      b: WorkspaceId,
    ) => Promise<void>,
  ) {
    test(`${name}: ${title}`, async () => {
      const fixture = await create();
      const a = workspaceIdSchema.parse(`test_a_${randomUUID()}`);
      const b = workspaceIdSchema.parse(`test_b_${randomUUID()}`);
      try {
        for (const id of [a, b])
          await fixture.repository.transaction(id, async (tx) => {
            await tx.workspace.insert(
              workspaceSchema.parse({ id, name: "Test", ...dates }),
            );
          });
        await run(fixture.repository, a, b);
      } finally {
        await fixture.dispose();
      }
    });
  }
  scenario(
    "caught repository errors still roll back the transaction",
    async (repo, a) => {
      await assert.rejects(
        repo.transaction(a, async (tx) => {
          await tx.services.insert(service(a));
          await assert.rejects(tx.services.insert(service(a)), {
            code: "already_exists",
          });
          // Returning normally cannot turn a database-aborted transaction into success.
        }),
        { code: "already_exists" },
      );
      assert.equal(
        await repo.transaction(a, (tx) => tx.services.get(service(a).id)),
        undefined,
      );
    },
  );
  scenario(
    "natural keys are scoped and foreign IDs look missing",
    async (repo, a, b) => {
      await repo.transaction(a, (tx) =>
        tx.services.insert(service(a, "service_a")),
      );
      await repo.transaction(b, (tx) =>
        tx.services.insert(service(b, "service_b")),
      );
      await repo.transaction(a, async (tx) => {
        assert.equal(
          await tx.services.get(service(b, "service_b").id),
          undefined,
        );
        assert.deepEqual((await tx.services.list({ limit: 100 })).items, [
          service(a, "service_a"),
        ]);
        assert.equal((await tx.workspace.get())?.id, a);
      });
    },
  );
  scenario(
    "environment and responder reads stay scoped, including shared host identities",
    async (repo, a, b) => {
      for (const [scope, suffix] of [
        [a, "a"],
        [b, "b"],
      ] as const)
        await repo.transaction(scope, async (tx) => {
          await tx.environments.insert(
            environmentSchema.parse({
              id: `environment_${suffix}`,
              workspaceId: scope,
              name: "Production",
              key: "production",
              isProduction: true,
              ...dates,
            }),
          );
          await tx.responders.insert(
            responderSchema.parse({
              id: `responder_${suffix}`,
              workspaceId: scope,
              hostUserId: "42",
              displayName: "Alex",
              timeZone: "UTC",
              role: "viewer",
              enabled: true,
              ...dates,
            }),
          );
        });
      await repo.transaction(a, async (tx) => {
        const envs = (await tx.environments.list({ limit: 100 })).items;
        const responders = (await tx.responders.list({ limit: 100 })).items;
        assert.equal(envs.length, 1);
        assert.equal(envs[0].workspaceId, a);
        assert.equal(responders.length, 1);
        assert.equal(responders[0].workspaceId, a);
        assert.equal(
          await tx.environments.get(environmentIdSchema.parse("environment_b")),
          undefined,
        );
        assert.equal(
          await tx.responders.get(responderIdSchema.parse("responder_b")),
          undefined,
        );
      });
    },
  );
  scenario(
    "audit IDs are immutable within their workspace",
    async (repo, a, b) => {
      await repo.transaction(a, (tx) => tx.audit.append(event(a)));
      await assert.rejects(
        repo.transaction(a, (tx) =>
          tx.audit.append({ ...event(a), action: "altered" }),
        ),
        { code: "already_exists" },
      );
      await repo.transaction(b, (tx) => tx.audit.append(event(b)));
      assert.deepEqual(
        await repo.transaction(
          a,
          async (tx) => (await tx.audit.list({ limit: 100 })).items,
        ),
        [event(a)],
      );
    },
  );
  scenario("all writes reject a mismatched workspace", async (repo, a, b) => {
    const environment = environmentSchema.parse({
      id: "environment_1",
      workspaceId: b,
      name: "Production",
      key: "production",
      isProduction: true,
      ...dates,
    });
    const responder = responderSchema.parse({
      id: "responder_1",
      workspaceId: b,
      hostUserId: "42",
      displayName: "Alex",
      timeZone: "UTC",
      role: "viewer",
      enabled: true,
      ...dates,
    });
    for (const write of [
      (tx: FoundationTransaction) => tx.services.insert(service(b)),
      (tx: FoundationTransaction) => tx.environments.insert(environment),
      (tx: FoundationTransaction) => tx.responders.insert(responder),
      (tx: FoundationTransaction) => tx.audit.append(event(b)),
      (tx: FoundationTransaction) =>
        tx.workspace.insert(
          workspaceSchema.parse({ id: b, name: "Bad", ...dates }),
        ),
    ])
      await assert.rejects(repo.transaction(a, write), {
        code: "scope_violation",
      });
    assert.equal(
      await repo.transaction(
        b,
        async (tx) => (await tx.services.list({ limit: 100 })).items.length,
      ),
      0,
    );
  });
  scenario(
    "an exception rolls back both mutation and audit",
    async (repo, a) => {
      await assert.rejects(
        repo.transaction(a, async (tx) => {
          await tx.services.insert(service(a));
          await tx.audit.append(event(a));
          throw new Error("injected failure before commit");
        }),
        /injected failure/,
      );
      await repo.transaction(a, async (tx) => {
        assert.equal(await tx.services.get(service(a).id), undefined);
        assert.equal((await tx.audit.list({ limit: 100 })).items.length, 0);
      });
    },
  );
  scenario(
    "successful mutations and audit commit together without cross-scope audit reads",
    async (repo, a, b) => {
      await repo.transaction(a, async (tx) => {
        await tx.services.insert(service(a));
        await tx.audit.append(event(a));
        assert.match(tx.now, /^\d{4}-\d{2}-\d{2}T.*Z$/);
      });
      await repo.transaction(a, async (tx) => {
        assert.deepEqual(await tx.services.get(service(a).id), service(a));
        assert.deepEqual((await tx.audit.list({ limit: 100 })).items, [
          event(a),
        ]);
      });
      assert.equal(
        await repo.transaction(
          b,
          async (tx) => (await tx.audit.list({ limit: 100 })).items.length,
        ),
        0,
      );
    },
  );
  scenario(
    "duplicate IDs and natural keys never overwrite existing records",
    async (repo, a) => {
      await repo.transaction(a, (tx) => tx.services.insert(service(a)));
      for (const value of [
        service(a, "service_1", "other"),
        service(a, "service_2", "api"),
      ]) {
        await assert.rejects(
          repo.transaction(a, (tx) => tx.services.insert(value)),
          { code: "already_exists" },
        );
      }
      assert.deepEqual(
        await repo.transaction(a, (tx) => tx.services.get(service(a).id)),
        service(a),
      );
    },
  );
  scenario(
    "concurrent conflicting inserts have exactly one winner",
    async (repo, a) => {
      const results = await Promise.allSettled(
        ["service_a", "service_b"].map((id) =>
          repo.transaction(a, (tx) => tx.services.insert(service(a, id))),
        ),
      );
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );
      assert.equal(
        await repo.transaction(
          a,
          async (tx) => (await tx.services.list({ limit: 100 })).items.length,
        ),
        1,
      );
    },
  );
  scenario("bounded pagination visits each record once", async (repo, a) => {
    await repo.transaction(a, async (tx) => {
      for (let i = 1; i <= 3; i++)
        await tx.services.insert(service(a, `service_${i}`, `api-${i}`));
    });
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const page = await repo.transaction(a, (tx) =>
        tx.services.list({ limit: 1, after }),
      );
      assert.equal(page.items.length, 1);
      ids.push(page.items[0].id);
      after = page.next ?? undefined;
    } while (after && ids.length < 5);
    assert.deepEqual(ids.sort(), ["service_1", "service_2", "service_3"]);
    for (const limit of [0, -1, 101, 1.5])
      await assert.rejects(
        repo.transaction(a, (tx) => tx.services.list({ limit })),
        { code: "invalid_page" },
      );
  });
  scenario(
    "returned values cannot mutate stored state and transaction handles expire",
    async (repo, a) => {
      let escaped!: FoundationTransaction;
      await repo.transaction(a, async (tx) => {
        escaped = tx;
        await tx.services.insert(service(a));
      });
      await assert.rejects(escaped.services.list({ limit: 100 }), {
        code: "closed_transaction",
      });
      const value = await repo.transaction(a, (tx) =>
        tx.services.get(service(a).id),
      );
      assert.ok(value);
      value.name = "not persisted";
      assert.equal(
        (await repo.transaction(a, (tx) => tx.services.get(service(a).id)))
          ?.name,
        "API",
      );
    },
  );
}
