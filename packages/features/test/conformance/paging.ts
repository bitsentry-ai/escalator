import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  acknowledgementGrantSchema,
  deliveryAttemptSchema,
  operationalIncidentSchema,
  operationalPageSchema,
  pageStepSchema,
  recipientDeliverySchema,
  serviceSchema,
  environmentSchema,
  responderSchema,
  workspaceIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type {
  PagingRepository,
  PagingTransaction,
} from "@bitsentry-escalator/features/application";

export interface PagingFixture {
  repository: PagingRepository;
  dispose(): Promise<void>;
}
export function pagingConformance(
  name: string,
  create: () => Promise<PagingFixture>,
  options: {
    skip?: string;
    register?: (name: string, run: () => Promise<void>) => unknown;
  } = {},
): void {
  const register =
    options.register ??
    ((title, run) => test(title, { skip: options.skip }, run));
  const scenario = (
    title: string,
    run: (
      repo: PagingRepository,
      scope: WorkspaceId,
      other: WorkspaceId,
    ) => Promise<void>,
  ) => {
    register(`${name}: ${title}`, async () => {
      const fixture = await create();
      const scope = workspaceIdSchema.parse(`paging_${randomUUID()}`);
      const other = workspaceIdSchema.parse(`paging_${randomUUID()}`);
      try {
        for (const workspaceId of [scope, other])
          await fixture.repository.transaction(workspaceId, async (tx) => {
            const dates = { createdAt: tx.now, updatedAt: tx.now };
            await tx.workspace.insert({
              id: workspaceId,
              name: "Paging",
              ...dates,
            });
            await tx.services.insert(
              serviceSchema.parse({
                id: "api",
                workspaceId,
                name: "API",
                key: "api",
                owningTeam: "Operations",
                enabled: true,
                ...dates,
              }),
            );
            await tx.environments.insert(
              environmentSchema.parse({
                id: "prod",
                workspaceId,
                name: "Production",
                key: "prod",
                isProduction: true,
                ...dates,
              }),
            );
            for (const id of ["primary", "peer"])
              await tx.responders.insert(
                responderSchema.parse({
                  id,
                  workspaceId,
                  hostUserId: id,
                  displayName: id,
                  timeZone: "UTC",
                  role: "responder",
                  enabled: true,
                  ...dates,
                }),
              );
            await seed(tx);
          });
        await run(fixture.repository, scope, other);
      } finally {
        await fixture.dispose();
      }
    });
  };
  scenario(
    "step and recipient uniqueness cannot be bypassed with a new record ID",
    async (repo, scope) => {
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const step = (await tx.steps.get("step"))!;
          await tx.steps.insert({ ...step, id: "duplicate" });
        }),
      );
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const delivery = (await tx.deliveries.get("delivery"))!;
          await tx.deliveries.insert({ ...delivery, id: "duplicate" });
        }),
      );
    },
  );
  scenario(
    "tokens persist only as digests and expire against database time",
    async (repo, scope) => {
      await repo.transaction(scope, async (tx) => {
        const grant = (await tx.grants.get("grant"))!;
        assert.equal(
          (await tx.grants.findValid(grant.tokenDigest))?.id,
          "grant",
        );
        assert.equal(await tx.grants.findValid("f".repeat(64)), undefined);
        await tx.grants.insert({
          ...grant,
          id: "expired",
          tokenDigest: "b".repeat(64),
          createdAt: new Date(Date.parse(tx.now) - 2000).toISOString(),
          expiresAt: tx.now,
        });
        assert.equal(await tx.grants.findValid("b".repeat(64)), undefined);
      });
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const grant = (await tx.grants.get("grant"))!;
          await tx.grants.insert({
            ...grant,
            id: "raw",
            tokenDigest: "not-a-digest",
          });
        }),
      );
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const grant = (await tx.grants.get("grant"))!;
          const unsafe = { ...grant, id: "raw", token: "secret-credential" };
          await tx.grants.insert(unsafe);
        }),
      );
    },
  );
  scenario(
    "scope failures poison the entire transaction even when caught",
    async (repo, scope, other) => {
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const page = (await tx.pages.get("page"))!;
          await tx.pages.insert({ ...page, id: "rolled-back" });
          try {
            await tx.pages.insert({
              ...page,
              id: "foreign",
              workspaceId: other,
            });
          } catch {
            /* deliberate */
          }
        }),
      );
      await repo.transaction(scope, async (tx) => {
        assert.equal(await tx.pages.get("rolled-back"), undefined);
      });
    },
  );
  scenario(
    "cross-workspace IDs remain missing and references cannot cross scope",
    async (repo, scope, other) => {
      await repo.transaction(other, async (tx) => {
        const page = (await tx.pages.get("page"))!;
        await tx.pages.insert({ ...page, id: "foreign-only" });
      });
      await repo.transaction(scope, async (tx) => {
        assert.equal(await tx.pages.lock("foreign-only"), undefined);
      });
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const step = (await tx.steps.get("step"))!;
          await tx.steps.insert({
            ...step,
            id: "bad-reference",
            pageId: "foreign-only",
          });
        }),
      );
    },
  );
  scenario(
    "concurrent locked updates retain one acknowledgement owner",
    async (repo, scope) => {
      const owners = await Promise.all(
        ["primary", "peer"].map((id) =>
          repo.transaction(scope, async (tx) => {
            const page = (await tx.pages.lock("page"))!;
            if (page.acknowledgedBy) return page.acknowledgedBy;
            const updated = operationalPageSchema.parse({
              ...page,
              state: "acknowledged",
              acknowledgedBy: id,
              acknowledgedAt: tx.now,
              revision: page.revision + 1,
            });
            assert.equal(await tx.pages.replace(updated, page.revision), true);
            return updated.acknowledgedBy;
          }),
        ),
      );
      assert.equal(owners[0], owners[1]);
      await repo.transaction(scope, async (tx) => {
        const page = (await tx.pages.lock("page"))!;
        assert.equal(
          await tx.pages.replace(
            { ...page, revision: page.revision + 1 },
            page.revision - 1,
          ),
          false,
        );
      });
    },
  );
  scenario(
    "policy snapshots cannot mutate and transaction handles expire",
    async (repo, scope) => {
      let escaped: PagingTransaction | undefined;
      await repo.transaction(scope, async (tx) => {
        escaped = tx;
      });
      await assert.rejects(escaped!.pages.get("page"));
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const page = (await tx.pages.lock("page"))!;
          await tx.pages.replace(
            {
              ...page,
              revision: page.revision + 1,
              policy: { ...page.policy, version: 2 },
            },
            page.revision,
          );
        }),
      );
    },
  );
  scenario(
    "an acknowledged owner and terminal resolution cannot be replaced",
    async (repo, scope) => {
      await repo.transaction(scope, async (tx) => {
        const page = (await tx.pages.lock("page"))!;
        await tx.pages.replace(
          operationalPageSchema.parse({
            ...page,
            state: "acknowledged",
            acknowledgedBy: "primary",
            acknowledgedAt: tx.now,
            revision: 2,
          }),
          1,
        );
      });
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const page = (await tx.pages.lock("page"))!;
          await tx.pages.replace(
            operationalPageSchema.parse({
              ...page,
              acknowledgedBy: "peer",
              revision: 3,
            }),
            2,
          );
        }),
      );
      await repo.transaction(scope, async (tx) => {
        const page = (await tx.pages.lock("page"))!;
        await tx.pages.replace(
          { ...page, state: "resolved", resolvedAt: tx.now, revision: 3 },
          2,
        );
      });
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const page = (await tx.pages.lock("page"))!;
          await tx.pages.replace(
            { ...page, state: "acknowledged", resolvedAt: null, revision: 4 },
            3,
          );
        }),
      );
    },
  );
  scenario(
    "a late attempt result survives acknowledgement without replacing another attempt",
    async (repo, scope) => {
      await repo.transaction(scope, async (tx) => {
        const page = (await tx.pages.lock("page"))!;
        await tx.pages.replace(
          operationalPageSchema.parse({
            ...page,
            state: "acknowledged",
            acknowledgedBy: "primary",
            acknowledgedAt: tx.now,
            revision: 2,
          }),
          1,
        );
        const attempt = (await tx.attempts.get("attempt"))!;
        await tx.attempts.insert({
          ...attempt,
          id: "retry",
          attempt: 2,
          claimToken: "claim-2",
        });
        const result = {
          ...attempt,
          finishedAt: tx.now,
          outcome: "unknown" as const,
          completedAfterAcknowledgement: true,
        };
        assert.equal(
          await tx.attempts.finish({ ...result, claimToken: "wrong" }),
          false,
        );
        assert.equal(await tx.attempts.finish(result), true);
        assert.equal(
          await tx.attempts.finish({
            ...result,
            outcome: "accepted",
            providerReceiptId: "receipt",
          }),
          false,
        );
        assert.equal((await tx.attempts.get("retry"))?.outcome, "in_flight");
      });
    },
  );
  scenario(
    "foundation and paging writes roll back together",
    async (repo, scope) => {
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const service = (await tx.services.get(
            serviceSchema.shape.id.parse("api"),
          ))!;
          await tx.services.insert({
            ...service,
            id: serviceSchema.shape.id.parse("rollback"),
            key: "rollback",
          });
          const page = (await tx.pages.get("page"))!;
          await tx.pages.insert({ ...page, id: "rollback" });
          await tx.work.enqueue("outbox", {
            id: "rollback",
            kind: "paging.delivery",
            idempotencyKey: "rollback",
            payload: { pageId: "rollback" },
            dueAt: tx.now,
          });
          throw new Error("rollback");
        }),
      );
      await repo.transaction(scope, async (tx) => {
        assert.equal(await tx.pages.get("rollback"), undefined);
        assert.equal(
          await tx.work.enqueue("outbox", {
            id: "rollback",
            kind: "paging.delivery",
            idempotencyKey: "rollback",
            payload: { pageId: "page" },
            dueAt: tx.now,
          }),
          "inserted",
        );
        assert.equal(
          await tx.services.get(serviceSchema.shape.id.parse("rollback")),
          undefined,
        );
      });
    },
  );
}

async function seed(tx: PagingTransaction): Promise<void> {
  const workspaceId = tx.workspaceId;
  await tx.incidents.insert(
    operationalIncidentSchema.parse({
      id: "incident",
      workspaceId,
      serviceId: "api",
      environmentId: "prod",
      title: "Unavailable",
      severity: "critical",
      openedAt: tx.now,
      resolvedAt: null,
    }),
  );
  await tx.pages.insert(
    operationalPageSchema.parse({
      id: "page",
      workspaceId,
      incidentId: "incident",
      createdAt: tx.now,
      state: "open",
      revision: 1,
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedAt: null,
      policy: {
        id: "policy",
        workspaceId,
        serviceId: "api",
        version: 1,
        primaryScheduleId: "primary",
        peerScheduleId: "peer",
        fallbackResponderIds: ["peer"],
        steps: [{ id: "initial", offsetMs: 0, target: "primary" }],
        terminal: {
          reminderIntervalMs: 60_000,
          maxReminders: 1,
          action: "notify_operator",
          notifyResponderIds: ["peer"],
        },
      },
    }),
  );
  await tx.steps.insert(
    pageStepSchema.parse({
      id: "step",
      workspaceId,
      pageId: "page",
      logicalStepId: "initial",
      dueAt: tx.now,
      recordedAt: tx.now,
      disposition: "dispatch",
      recipientIds: ["primary"],
    }),
  );
  await tx.deliveries.insert(
    recipientDeliverySchema.parse({
      id: "delivery",
      workspaceId,
      pageId: "page",
      stepId: "step",
      recipientId: "primary",
      contactId: "contact",
      channel: "pushover",
      createdAt: tx.now,
    }),
  );
  await tx.attempts.insert(
    deliveryAttemptSchema.parse({
      id: "attempt",
      workspaceId,
      deliveryId: "delivery",
      attempt: 1,
      claimToken: "claim-1",
      startedAt: tx.now,
      finishedAt: null,
      outcome: "in_flight",
      providerReceiptId: null,
      completedAfterAcknowledgement: false,
    }),
  );
  await tx.grants.insert(
    acknowledgementGrantSchema.parse({
      id: "grant",
      workspaceId,
      pageId: "page",
      recipientId: "primary",
      attemptId: "attempt",
      tokenDigest: "a".repeat(64),
      createdAt: tx.now,
      expiresAt: new Date(Date.parse(tx.now) + 600_000).toISOString(),
    }),
  );
}
