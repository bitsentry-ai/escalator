import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceSchema,
  workspaceIdSchema,
  serviceSchema,
  environmentSchema,
  responderSchema,
  detectionRuleSchema,
  type Actor,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  RuleDrafts,
  ReviewRuleActivation,
  type RuleCatalogRepository,
  type FoundationRepository,
  type LabelStream,
} from "@bitsentry-escalator/features/application";
export interface RuleCatalogFixture {
  repository: RuleCatalogRepository;
  foundation: FoundationRepository;
  seedStream(stream: LabelStream): Promise<void>;
  queued(scope: WorkspaceId): Promise<number>;
  /** Use a separate connection with a short lock timeout. */
  insertBinding(stream: LabelStream): Promise<void>;
  dispose(): Promise<void>;
}
export function ruleCatalogConformance(
  name: string,
  factory: () => Promise<RuleCatalogFixture>,
  options: {
    skip?: string;
    register?: (title: string, work: () => Promise<void>) => unknown;
  } = {},
) {
  const register =
    options.register ??
    ((title, work) => test(title, { skip: options.skip }, work));
  async function seed(f: RuleCatalogFixture) {
    const workspaceId = workspaceIdSchema.parse(randomUUID()),
      serviceId = serviceSchema.shape.id.parse(randomUUID()),
      environmentId = environmentSchema.shape.id.parse(randomUUID()),
      responderId = randomUUID(),
      streamId = randomUUID();
    const dates = {
      createdAt: "2026-10-07T00:00:00.000Z",
      updatedAt: "2026-10-07T00:00:00.000Z",
    };
    await f.foundation.transaction(workspaceId, async (tx) => {
      await tx.workspace.insert(
        workspaceSchema.parse({
          id: workspaceId,
          name: "Rule catalog",
          ...dates,
        }),
      );
      await tx.services.insert(
        serviceSchema.parse({
          id: serviceId,
          workspaceId,
          name: "API",
          key: "api",
          owningTeam: "Platform",
          enabled: true,
          ...dates,
        }),
      );
      await tx.environments.insert(
        environmentSchema.parse({
          id: environmentId,
          workspaceId,
          name: "Production",
          key: "production",
          isProduction: true,
          ...dates,
        }),
      );
      await tx.responders.insert(
        responderSchema.parse({
          id: responderId,
          workspaceId,
          hostUserId: randomUUID(),
          displayName: "Reviewer",
          timeZone: "UTC",
          role: "administrator",
          enabled: true,
          ...dates,
        }),
      );
    });
    await f.seedStream({
      workspaceId,
      serviceId,
      environmentId,
      kind: "probe",
      id: streamId,
    });
    const actor: Actor = {
      workspaceId,
      responderId: responderSchema.shape.id.parse(responderId),
      role: "administrator",
    };
    const definition = detectionRuleSchema.parse({
      languageVersion: 1,
      workspaceId,
      serviceId,
      environmentId,
      selector: { kind: "probe", streamId, field: "failure" },
      aggregation: "maximum",
      windowSeconds: 60,
      stepSeconds: 60,
      minimumSamples: 1,
      trigger: { operator: "gte", value: 1 },
      recovery: { operator: "lt", value: 1 },
      persistenceSeconds: 0,
      recoverySeconds: 0,
      cooldownSeconds: 0,
      severity: "high",
    });
    const drafts = new RuleDrafts(f.repository, randomUUID),
      review = new ReviewRuleActivation(f.repository, randomUUID);
    const entry = await drafts.create(actor, {
      title: "Candidate",
      definition,
    });
    const receipt = () =>
      review.review(actor, {
        ruleId: entry.id,
        expectedRevision: 1,
        versionRevision: 1,
        mode: "shadow",
        runId: null,
      });
    return { actor, entry, definition, drafts, review, receipt };
  }
  function scenario(
    title: string,
    run: (
      f: RuleCatalogFixture,
      s: Awaited<ReturnType<typeof seed>>,
    ) => Promise<void>,
  ) {
    register(`${name}: ${title}`, async () => {
      const f = await factory();
      try {
        await run(f, await seed(f));
      } finally {
        await f.dispose();
      }
    });
  }
  scenario(
    "concurrent consumption of one receipt creates one runtime and one job",
    async (f, s) => {
      const receipt = await s.receipt(),
        before = await f.queued(s.actor.workspaceId);
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          s.review.activate(s.actor, {
            ruleId: s.entry.id,
            receiptId: receipt.id,
          }),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(await f.queued(s.actor.workspaceId), before + 1);
      await f.repository.transaction(s.actor.workspaceId, async (tx) => {
        const entry = await tx.catalog.lock(s.entry.id),
          runtime = await tx.catalog.runtime(s.entry.id);
        assert.equal(entry?.status, "shadow");
        assert.equal(entry?.revision, 2);
        assert.equal(runtime?.generation, 1);
        assert.equal(runtime?.state, null);
      });
    },
  );
  scenario(
    "queue failure rolls back runtime and catalog changes",
    async (f, s) => {
      const receipt = await s.receipt(),
        before = await f.queued(s.actor.workspaceId);
      const failing: RuleCatalogRepository = {
        transaction: (scope, work) =>
          f.repository.transaction(scope, (tx) =>
            work({
              ...tx,
              work: {
                ...tx.work,
                enqueue: async () => {
                  throw new Error("Injected queue failure");
                },
              },
            }),
          ),
      };
      await assert.rejects(
        new ReviewRuleActivation(failing, randomUUID).activate(s.actor, {
          ruleId: s.entry.id,
          receiptId: receipt.id,
        }),
        /Injected queue failure/,
      );
      await f.repository.transaction(s.actor.workspaceId, async (tx) => {
        assert.equal((await tx.catalog.lock(s.entry.id))?.revision, 1);
        assert.equal(await tx.catalog.runtime(s.entry.id), undefined);
      });
      assert.equal(await f.queued(s.actor.workspaceId), before);
    },
  );
  scenario(
    "a content revision invalidates an earlier receipt without overwriting history",
    async (f, s) => {
      const receipt = await s.receipt();
      await s.drafts.edit(s.actor, {
        ruleId: s.entry.id,
        expectedRevision: 1,
        definition: { ...s.definition, minimumSamples: 2 },
      });
      await assert.rejects(
        s.review.activate(s.actor, {
          ruleId: s.entry.id,
          receiptId: receipt.id,
        }),
      );
      await f.repository.transaction(s.actor.workspaceId, async (tx) => {
        await tx.catalog.lock(s.entry.id);
        assert.equal(
          (await tx.catalog.version(s.entry.id, 1))?.definition.minimumSamples,
          1,
        );
        assert.equal(
          (await tx.catalog.version(s.entry.id, 2))?.definition.minimumSamples,
          2,
        );
        assert.equal(await tx.catalog.runtime(s.entry.id), undefined);
      });
    },
  );
  scenario(
    "review locks block insertion of a previously absent binding",
    async (f, s) => {
      await f.repository.transaction(s.actor.workspaceId, async (tx) => {
        await tx.catalog.lock(s.entry.id);
        await assert.rejects(
          f.insertBinding({
            workspaceId: s.actor.workspaceId,
            serviceId: s.definition.serviceId,
            environmentId: s.definition.environmentId,
            kind: s.definition.selector.kind,
            id: s.definition.selector.streamId,
          }),
          { code: "55P03" },
        );
      });
    },
  );
  scenario(
    "the database rejects a live catalog without its matching runtime",
    async (f, s) => {
      await assert.rejects(
        f.repository.transaction(s.actor.workspaceId, async (tx) => {
          const entry = await tx.catalog.lock(s.entry.id);
          assert.ok(entry);
          const accepted = await tx.catalog.save(
            {
              ...entry,
              revision: 2,
              generation: 1,
              status: "shadow",
              updatedAt: await tx.catalog.currentTime(),
            },
            1,
          );
          assert.equal(accepted, true);
        }),
      );
      await f.repository.transaction(s.actor.workspaceId, async (tx) => {
        assert.equal((await tx.catalog.lock(s.entry.id))?.revision, 1);
      });
    },
  );
  scenario(
    "foreign scope and mismatched cached roles cannot operate on a rule",
    async (f, s) => {
      const other = await seed(f);
      await f.repository.transaction(other.actor.workspaceId, async (tx) => {
        assert.equal(await tx.catalog.lock(s.entry.id), undefined);
        assert.equal(await tx.catalog.version(s.entry.id, 1), undefined);
      });
      await assert.rejects(
        s.review.review(
          { ...s.actor, role: "viewer" },
          {
            ruleId: s.entry.id,
            expectedRevision: 1,
            versionRevision: 1,
            mode: "shadow",
            runId: null,
          },
        ),
        /forbidden/,
      );
    },
  );
}
