import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import {
  acknowledgementGrantSchema,
  deliveryAttemptSchema,
  operationalIncidentSchema,
  operationalPageSchema,
  escalationPolicySchema,
  deploymentPagePolicySchema,
  pageStepSchema,
  recipientDeliverySchema,
  serviceSchema,
  environmentSchema,
  responderSchema,
  responderIdSchema,
  workspaceIdSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type {
  PagingRepository,
  PagingTransaction,
} from "@bitsentry-escalator/features/application";

import {
  PageAcknowledgements,
  PageCreation,
  acknowledgementDigest,
  pagingWorkId,
  escalationSteps,
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
          await fixture.repository.transaction(workspaceId, seedPagingFixture);
        await run(fixture.repository, scope, other);
      } finally {
        await fixture.dispose();
      }
    });
  };
  scenario(
    "round-trips immutable timeout routing without changing the configured ladder",
    async (repo, scope, other) => {
      const original = await repo.transaction(
        scope,
        async (tx) => (await tx.pages.get("page"))!,
      );
      const policy = deploymentPagePolicySchema.parse({
        id: "timeout-policy",
        workspaceId: scope,
        serviceId: original.policy.serviceId,
        version: 1,
        deployment: {
          id: "deployment",
          mappedDeployerId: "primary",
          sourcePolicyId: original.policy.id,
          sourcePolicyVersion: original.policy.version,
        },
        fallbackResponderIds: original.policy.fallbackResponderIds,
        steps: [
          { id: "deployer", offsetMs: 0, target: "deployer" },
          { id: "service-fallback", offsetMs: 120000, target: "fallback" },
        ],
        terminal: original.policy.terminal,
      });
      const incident = await repo.transaction(
        scope,
        async (tx) => (await tx.incidents.get("incident"))!,
      );
      const created = await new PageCreation(repo).open(scope, {
        incident: {
          id: "timeout-incident",
          serviceId: incident.serviceId,
          environmentId: incident.environmentId,
          title: "Stuck deploy",
          severity: "high",
        },
        policy,
      });
      await repo.transaction(scope, async (tx) => {
        const stored = (await tx.pages.get(created.id))!;
        assert.deepEqual(stored.policy, policy);
        assert.deepEqual((await tx.pages.get("page"))!.policy, original.policy);
      });
      assert.equal(
        await repo.transaction(other, (tx) => tx.pages.get(created.id)),
        undefined,
      );
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const stored = (await tx.pages.lock(created.id))!;
          assert.ok("deployment" in stored.policy);
          await tx.pages.replace(
            {
              ...stored,
              revision: stored.revision + 1,
              policy: {
                ...policy,
                deployment: {
                  ...policy.deployment,
                  mappedDeployerId: responderIdSchema.parse("peer"),
                },
              },
            },
            stored.revision,
          );
        }),
      );
    },
  );
  scenario(
    "acknowledgement rollback leaves ownership and cancellation unchanged",
    async (repo, scope) => {
      const token = randomBytes(32).toString("base64url");
      await repo.transaction(scope, async (tx) => {
        const grant = (await tx.grants.get("grant"))!;
        await tx.grants.insert({
          ...grant,
          id: "rollback-token",
          tokenDigest: acknowledgementDigest(token)!,
        });
        const id = pagingWorkId(scope, "send", "delivery");
        await tx.work.enqueue("outbox", {
          id,
          kind: "paging.send",
          idempotencyKey: id,
          payload: {},
          dueAt: tx.now,
        });
      });
      const failing: PagingRepository = {
        transaction: (workspace, work) =>
          repo.transaction(workspace, (tx) =>
            work({
              ...tx,
              audit: {
                ...tx.audit,
                append: async () => {
                  throw new Error("Audit storage unavailable");
                },
              },
            }),
          ),
      };
      await assert.rejects(
        new PageAcknowledgements(failing).acknowledge(scope, token),
      );
      await repo.transaction(scope, async (tx) => {
        assert.equal((await tx.pages.get("page"))?.state, "open");
        assert.equal((await tx.audit.list({ limit: 10 })).items.length, 0);
        assert.equal(
          await tx.work.cancel("outbox", [
            pagingWorkId(scope, "send", "delivery"),
          ]),
          1,
        );
        const id = pagingWorkId(scope, "cancel", "delivery");
        assert.equal(
          await tx.work.enqueue("job", {
            id,
            kind: "paging.cancel",
            idempotencyKey: id,
            payload: {},
            dueAt: tx.now,
          }),
          "inserted",
        );
      });
    },
  );
  scenario(
    "first token acknowledgement owns the page and commits cancellation atomically",
    async (repo, scope, other) => {
      const tokens = [
        randomBytes(32).toString("base64url"),
        randomBytes(32).toString("base64url"),
      ];
      await repo.transaction(scope, async (tx) => {
        const step = (await tx.steps.get("step"))!;
        const delivery = (await tx.deliveries.get("delivery"))!;
        const attempt = (await tx.attempts.get("attempt"))!;
        const grant = (await tx.grants.get("grant"))!;
        await tx.steps.insert({
          ...step,
          id: "peer-step",
          logicalStepId: "reminder:1",
          recipientIds: [responderIdSchema.parse("peer")],
        });
        await tx.deliveries.insert({
          ...delivery,
          id: "peer-delivery",
          stepId: "peer-step",
          recipientId: responderIdSchema.parse("peer"),
        });
        await tx.attempts.insert({
          ...attempt,
          id: "peer-attempt",
          deliveryId: "peer-delivery",
        });
        for (const [i, recipientId] of ["primary", "peer"].entries()) {
          await tx.grants.insert({
            ...grant,
            id: "token-" + i,
            recipientId: responderIdSchema.parse(recipientId),
            attemptId: i === 0 ? "attempt" : "peer-attempt",
            tokenDigest: acknowledgementDigest(tokens[i]!)!,
          });
        }
        const page = (await tx.pages.get("page"))!;
        for (const entry of escalationSteps(page.policy, page.createdAt)) {
          const id = pagingWorkId(scope, "step", page.id, entry.id);
          await tx.work.enqueue("job", {
            id,
            kind: "paging.step",
            idempotencyKey: id,
            payload: { pageId: page.id },
            dueAt: tx.now,
          });
        }
        const id = pagingWorkId(scope, "send", "delivery");
        await tx.work.enqueue("outbox", {
          id,
          kind: "paging.send",
          idempotencyKey: id,
          payload: { deliveryId: "delivery" },
          dueAt: tx.now,
        });
      });
      const use = new PageAcknowledgements(repo);
      assert.equal((await use.preview(scope, tokens[0]!)).state, "open");
      await repo.transaction(scope, async (tx) => {
        assert.equal((await tx.pages.get("page"))?.state, "open");
        assert.equal((await tx.audit.list({ limit: 100 })).items.length, 0);
      });
      assert.deepEqual(await use.acknowledge(other, tokens[0]!), {
        state: "invalid",
      });
      assert.deepEqual(await use.acknowledge(scope, "malformed"), {
        state: "invalid",
      });
      const results = await Promise.all(
        tokens.map((token) => use.acknowledge(scope, token)),
      );
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0]!.state, "acknowledged");
      assert.deepEqual(await use.acknowledge(scope, tokens[1]!), results[0]);
      await repo.transaction(scope, async (tx) => {
        const page = (await tx.pages.get("page"))!;
        assert.ok(page.acknowledgedBy);
        assert.equal(page.revision, 2);
        const audit = (await tx.audit.list({ limit: 100 })).items;
        assert.equal(audit.length, 1);
        assert.equal(audit[0]!.action, "page.acknowledged");
        assert.ok(
          tokens.every((token) => !JSON.stringify(audit).includes(token)),
        );
        const attempt = (await tx.attempts.get("attempt"))!;
        assert.equal(attempt.outcome, "in_flight");
        assert.equal(
          await tx.attempts.finish({
            ...attempt,
            outcome: "accepted",
            finishedAt: tx.now,
            providerReceiptId: "receipt",
            completedAfterAcknowledgement: true,
          }),
          true,
        );
        const cancelId = pagingWorkId(scope, "cancel", "delivery");
        assert.equal(
          await tx.work.enqueue("job", {
            id: cancelId,
            kind: "paging.cancel",
            idempotencyKey: cancelId,
            payload: {},
            dueAt: tx.now,
          }),
          "duplicate",
        );
        const stepIds = escalationSteps(page.policy, page.createdAt).map((x) =>
          pagingWorkId(scope, "step", page.id, x.id),
        );
        assert.equal(await tx.work.cancel("job", stepIds), 0);
        assert.equal(
          await tx.work.cancel("outbox", [
            pagingWorkId(scope, "send", "delivery"),
          ]),
          0,
        );
      });
    },
  );
  scenario(
    "parent queries paginate without leaking another page or workspace",
    async (repo, scope, other) => {
      await repo.transaction(scope, async (tx) => {
        const page = (await tx.pages.get("page"))!;
        const step = (await tx.steps.get("step"))!;
        const delivery = (await tx.deliveries.get("delivery"))!;
        const attempt = (await tx.attempts.get("attempt"))!;
        await tx.pages.insert({ ...page, id: "page-2" });
        await tx.steps.insert({ ...step, id: "step-2", pageId: "page-2" });
        await tx.deliveries.insert({
          ...delivery,
          id: "delivery-2",
          pageId: "page-2",
          stepId: "step-2",
        });
        await tx.attempts.insert({
          ...attempt,
          id: "attempt-2",
          deliveryId: "delivery-2",
        });
        await tx.attempts.insert({
          ...attempt,
          id: "attempt-3",
          attempt: attempt.attempt + 1,
        });
        assert.deepEqual(
          (await tx.steps.forPage("page", { limit: 1 })).items.map((x) => x.id),
          ["step"],
        );
        assert.deepEqual(
          (await tx.deliveries.forPage("page-2", { limit: 1 })).items.map(
            (x) => x.id,
          ),
          ["delivery-2"],
        );
        const first = await tx.attempts.forDelivery("delivery", { limit: 1 });
        assert.equal(first.items[0]?.id, "attempt");
        assert.equal(first.next, "attempt");
        const last = await tx.attempts.forDelivery("delivery", {
          limit: 1,
          after: first.next!,
        });
        assert.equal(last.items[0]?.id, "attempt-3");
        assert.equal(last.next, null);
      });
      await repo.transaction(other, async (tx) => {
        assert.deepEqual(
          (await tx.steps.forPage("page-2", { limit: 10 })).items,
          [],
        );
        assert.deepEqual(
          (await tx.deliveries.forPage("page-2", { limit: 10 })).items,
          [],
        );
        assert.deepEqual(
          (await tx.attempts.forDelivery("delivery-2", { limit: 10 })).items,
          [],
        );
      });
      await assert.rejects(
        repo.transaction(scope, (tx) =>
          tx.steps.forPage("page", { limit: 101 }),
        ),
      );
    },
  );
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
              policy: {
                ...escalationPolicySchema.parse(page.policy),
                version: 2,
              },
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
      secretId: "secret",
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

/** Populates one scoped graph for conformance and direct host RLS checks. */
export async function seedPagingFixture(tx: PagingTransaction): Promise<void> {
  const workspaceId = tx.workspaceId;
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
}
