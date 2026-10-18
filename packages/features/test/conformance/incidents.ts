import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  responderIdSchema,
  environmentIdSchema,
  manualIncidentInputSchema,
  scheduleSchema,
  schedulePreviewSchema,
  configuredPolicySchema,
  type Actor,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  IncidentUseCases,
  previewSchedule,
  pagingWorkId,
  type ConfigurationRepository,
} from "@bitsentry-escalator/features/application";
import { seedPagingFixture } from "./paging.js";
export function incidentConformance(
  name: string,
  create: () => Promise<{
    repository: ConfigurationRepository;
    dispose(): Promise<void>;
  }>,
  options: {
    skip?: string;
    register?: (name: string, run: () => Promise<void>) => unknown;
  } = {},
) {
  const register =
    options.register ??
    ((title, run) => test(title, { skip: options.skip }, run));
  const scenario = (
    title: string,
    run: (repo: ConfigurationRepository, actor: Actor) => Promise<void>,
  ) =>
    register(`${name}: ${title}`, async () => {
      const fixture = await create();
      const scope = workspaceIdSchema.parse(`incidents_${randomUUID()}`);
      try {
        await fixture.repository.transaction(scope, seedPagingFixture);
        await seedPolicy(fixture.repository, scope);
        await run(fixture.repository, {
          workspaceId: scope,
          responderId: responderIdSchema.parse("primary"),
          role: "responder",
        });
      } finally {
        await fixture.dispose();
      }
    });
  const input = (requestId: string) =>
    manualIncidentInputSchema.parse({
      requestId,
      serviceId: "api",
      environmentId: "prod",
      policyId: "policy",
      title: "Manual outage",
      severity: "critical",
    });
  scenario(
    "manual creation is idempotent, responder-attributed and frozen after policy changes",
    async (repo, actor) => {
      const app = new IncidentUseCases(repo, randomUUID);
      const fields = input("manual");
      const created = await app.create(actor, fields);
      assert.deepEqual(await app.create(actor, fields), created);
      await repo.transaction(actor.workspaceId, async (tx) => {
        const events = (await tx.audit.list({ limit: 100 })).items;
        assert.equal(events.length, 1);
        assert.deepEqual(events[0]!.actor, {
          kind: "responder",
          responderId: actor.responderId,
        });
        const policy = (await tx.configuration.policies.get("policy"))!;
        assert.equal(
          await tx.configuration.policies.put(
            { ...policy, enabled: false, version: 2 },
            1,
          ),
          true,
        );
      });
      assert.deepEqual(await app.create(actor, fields), created);
      await assert.rejects(app.create(actor, input("disabled")), {
        code: "paging_unavailable",
      });
      await assert.rejects(
        app.create(actor, { ...fields, title: "Different" }),
        { code: "already_exists" },
      );
      const detail = await app.detail(actor, { id: created.incidentId });
      assert.equal(detail.policyVersion, 1);
      assert.equal(detail.owner, null);
      assert.deepEqual(
        detail.timeline.map((step) => [
          step.target,
          Date.parse(step.dueAt) - Date.parse(detail.incident.openedAt),
          step.disposition,
        ]),
        [
          ["primary", 0, "pending"],
          ["fallback", 60000, "pending"],
          ["operator", 120000, "pending"],
        ],
      );
    },
  );
  scenario(
    "failed manual audit rolls back incident, page and all deadlines",
    async (repo, actor) => {
      const failing: ConfigurationRepository = {
        transaction: (scope, run) =>
          repo.transaction(scope, (tx) =>
            run({
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
        new IncidentUseCases(failing, randomUUID).create(
          actor,
          input("rollback"),
        ),
        /audit unavailable/,
      );
      await repo.transaction(actor.workspaceId, async (tx) => {
        const pageId = pagingWorkId(actor.workspaceId, "page", "rollback");
        assert.equal(await tx.incidents.get("rollback"), undefined);
        assert.equal(await tx.pages.get(pageId), undefined);
        assert.equal(
          await tx.work.cancel(
            "job",
            ["initial", "reminder:1", "terminal"].map((id) =>
              pagingWorkId(actor.workspaceId, "step", pageId, id),
            ),
          ),
          0,
        );
        assert.equal((await tx.audit.list({ limit: 10 })).items.length, 0);
      });
    },
  );
  scenario(
    "list shows open incidents newest first with a stable cursor",
    async (repo, actor) => {
      await repo.transaction(actor.workspaceId, async (tx) => {
        const fixture = (await tx.incidents.get("incident"))!;
        const at = (hours: number) =>
          new Date(
            Date.parse(fixture.openedAt) + hours * 3600_000,
          ).toISOString();
        for (const [id, opened, resolved] of [
          ["0-resolved", 2, 3],
          ["aa-older", -1, null],
          ["tie-b", -2, null],
          ["tie-a", -2, null],
          ["zz-newest", 1, null],
        ] as const)
          await tx.incidents.insert({
            ...fixture,
            id,
            openedAt: at(opened),
            resolvedAt: resolved === null ? null : at(resolved),
          });
      });
      const app = new IncidentUseCases(repo, randomUUID);
      assert.equal((await app.list(actor)).items[0]!.id, "zz-newest");
      const seen: string[] = [];
      let after: string | undefined;
      do {
        const page = await app.list(actor, { limit: 2, after });
        seen.push(...page.items.map((incident) => incident.id));
        after = page.next ?? undefined;
      } while (after);
      assert.deepEqual(seen, [
        "zz-newest",
        "incident",
        "aa-older",
        "tie-a",
        "tie-b",
        "0-resolved",
      ]);
      await assert.rejects(app.list(actor, { after: "incident" }));
    },
  );
  scenario(
    "roles, environment creation and foreign scopes stay isolated",
    async (repo, actor) => {
      const app = new IncidentUseCases(repo, randomUUID);
      await assert.rejects(
        app.create({ ...actor, role: "viewer" }, input("viewer")),
        { code: "forbidden" },
      );
      await assert.rejects(
        app.createEnvironment(actor, {
          name: "Stage",
          key: "stage",
          isProduction: false,
        }),
        { code: "forbidden" },
      );
      await app.createEnvironment(
        { ...actor, role: "administrator" },
        { name: "Stage", key: "stage", isProduction: false },
      );
      assert.equal((await app.listEnvironments(actor)).items.length, 2);
      const created = await app.create(actor, input("scoped"));
      await assert.rejects(
        app.detail(
          { ...actor, workspaceId: workspaceIdSchema.parse("foreign") },
          { id: created.incidentId },
        ),
        { code: "not_found" },
      );
      await assert.rejects(
        app.create(actor, {
          ...input("bad-environment"),
          environmentId: environmentIdSchema.parse("foreign"),
        }),
        { code: "not_found" },
      );
    },
  );
  scenario(
    "detail and paged attempts exclude stored credential bindings and claim tokens",
    async (repo, actor) => {
      const app = new IncidentUseCases(repo, randomUUID);
      const created = await app.create(actor, input("details"));
      await repo.transaction(actor.workspaceId, async (tx) => {
        const page = (await tx.pages.get(created.pageId))!;
        const step = (await tx.steps.get("step"))!;
        await tx.steps.insert({
          ...step,
          id: "new-step",
          pageId: page.id,
          dueAt: page.createdAt,
          recordedAt: tx.now,
        });
        const delivery = (await tx.deliveries.get("delivery"))!;
        await tx.deliveries.insert({
          ...delivery,
          id: "a-delivery",
          pageId: page.id,
          stepId: "new-step",
          createdAt: tx.now,
        });
        const attempt = (await tx.attempts.get("attempt"))!;
        for (let i = 1; i <= 7; i++) {
          const pending = {
            ...attempt,
            id: `safe-attempt-${i}`,
            deliveryId: "a-delivery",
            attempt: i,
            startedAt: tx.now,
            claimToken: "private-claim",
          };
          await tx.attempts.insert(pending);
          assert.equal(
            await tx.attempts.finish({
              ...pending,
              finishedAt: tx.now,
              outcome: "accepted",
              providerReceiptId: "private-receipt",
            }),
            true,
          );
        }
      });
      const deliveries = await app.deliveries(actor, {
        incidentId: created.incidentId,
      });
      const first = deliveries.items[0]!;
      assert.equal(first.attempts.items.length, 5);
      assert.ok(first.attempts.next);
      assert.equal(
        (
          await app.attempts(actor, {
            incidentId: created.incidentId,
            deliveryId: first.id,
            after: first.attempts.next!,
          })
        ).items.length,
        2,
      );
      const serialized = JSON.stringify(deliveries);
      for (const hidden of [
        "secretId",
        "contactId",
        "claimToken",
        "providerReceiptId",
        "private-claim",
        "private-receipt",
      ])
        assert.equal(serialized.includes(hidden), false);
      await assert.rejects(
        app.attempts(actor, {
          incidentId: created.incidentId,
          deliveryId: "delivery",
        }),
        { code: "not_found" },
      );
      const detail = await app.detail(actor, { id: created.incidentId });
      assert.equal(detail.timeline[0]!.disposition, "dispatch");
      assert.equal(detail.timeline[0]!.recipientCount, 1);
    },
  );
}
async function seedPolicy(repo: ConfigurationRepository, scope: WorkspaceId) {
  await repo.transaction(scope, async (tx) => {
    const schedule = scheduleSchema.parse({
      id: "primary",
      workspaceId: scope,
      serviceId: "api",
      name: "Primary",
      version: 1,
      enabled: true,
      rotations: [],
      overrides: [],
    });
    await tx.configuration.schedules.put(schedule, null);
    const startsAt = "2026-09-20T00:00:00.000Z",
      endsAt = "2026-09-21T00:00:00.000Z";
    const preview = schedulePreviewSchema.parse({
      id: "preview",
      workspaceId: scope,
      scheduleId: schedule.id,
      serviceId: schedule.serviceId,
      scheduleVersion: 1,
      createdAt: tx.now,
      startsAt,
      endsAt,
      intervals: previewSchedule(schedule, startsAt, endsAt),
    });
    await tx.configuration.previews.insert(preview);
    await tx.configuration.policies.put(
      configuredPolicySchema.parse({
        ...(await tx.pages.get("page"))!.policy,
        peerScheduleId: schedule.id,
        enabled: true,
        primaryPreviewId: preview.id,
        peerPreviewId: preview.id,
      }),
      null,
    );
  });
}
