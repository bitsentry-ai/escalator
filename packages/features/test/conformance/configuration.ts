import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  scheduleSchema,
  configuredPolicySchema,
  configuredContactSchema,
  workspaceIdSchema,
  schedulePreviewSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  previewSchedule,
  type ConfigurationRepository,
  type ConfigurationTransaction,
} from "@bitsentry-escalator/features/application";
import { seedPagingFixture } from "./paging.js";
export function configurationConformance(
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
  function scenario(
    title: string,
    run: (
      repo: ConfigurationRepository,
      scope: WorkspaceId,
      other: WorkspaceId,
    ) => Promise<void>,
  ) {
    register(`${name}: ${title}`, async () => {
      const fixture = await create();
      const scope = workspaceIdSchema.parse(`configuration_${randomUUID()}`);
      const other = workspaceIdSchema.parse(`configuration_${randomUUID()}`);
      try {
        for (const id of [scope, other])
          await fixture.repository.transaction(id, seedPagingFixture);
        await run(fixture.repository, scope, other);
      } finally {
        await fixture.dispose();
      }
    });
  }
  const schedule = (scope: WorkspaceId) =>
    scheduleSchema.parse({
      id: "primary",
      workspaceId: scope,
      serviceId: "api",
      name: "Primary",
      version: 1,
      enabled: true,
      rotations: [],
      overrides: [],
    });
  async function seed(repo: ConfigurationRepository, scope: WorkspaceId) {
    return repo.transaction(scope, async (tx) => {
      const value = schedule(scope);
      await tx.configuration.schedules.put(value, null);
      const preview = schedulePreviewSchema.parse({
        id: "preview",
        workspaceId: scope,
        scheduleId: value.id,
        serviceId: value.serviceId,
        scheduleVersion: 1,
        createdAt: tx.now,
        startsAt: "2026-09-20T00:00:00.000Z",
        endsAt: "2026-09-21T00:00:00.000Z",
        intervals: previewSchedule(
          value,
          "2026-09-20T00:00:00.000Z",
          "2026-09-21T00:00:00.000Z",
        ),
      });
      await tx.configuration.previews.insert(preview);
      const policy = configuredPolicySchema.parse({
        ...(await tx.pages.get("page"))!.policy,
        peerScheduleId: value.id,
        enabled: true,
        primaryPreviewId: preview.id,
        peerPreviewId: preview.id,
      });
      await tx.configuration.policies.put(policy, null);
      return { value, preview, policy };
    });
  }
  scenario(
    "version compare-and-swap has one winner and preserves identity",
    async (repo, scope) => {
      const value = schedule(scope);
      await repo.transaction(scope, (tx) =>
        tx.configuration.schedules.put(value, null),
      );
      const results = await Promise.all(
        ["first", "second"].map((name) =>
          repo.transaction(scope, (tx) =>
            tx.configuration.schedules.put({ ...value, version: 2, name }, 1),
          ),
        ),
      );
      assert.equal(results.filter(Boolean).length, 1);
      await assert.rejects(
        repo.transaction(scope, (tx) =>
          tx.configuration.schedules.put({ ...value, version: 4 }, 2),
        ),
        /invalid_version/,
      );
      await assert.rejects(
        repo.transaction(scope, (tx) =>
          tx.configuration.schedules.put(
            {
              ...value,
              version: 3,
              serviceId: "foreign" as typeof value.serviceId,
            },
            2,
          ),
        ),
        /identity_change/,
      );
    },
  );
  scenario(
    "scope and pagination cannot reveal another workspace",
    async (repo, scope, other) => {
      await repo.transaction(scope, (tx) =>
        tx.configuration.schedules.put(schedule(scope), null),
      );
      await repo.transaction(other, async (tx) => {
        assert.equal(
          await tx.configuration.schedules.get(schedule(scope).id),
          undefined,
        );
        assert.deepEqual(
          (await tx.configuration.schedules.list({ limit: 1 })).items,
          [],
        );
      });
      await assert.rejects(
        repo.transaction(other, (tx) =>
          tx.configuration.schedules.put(schedule(scope), null),
        ),
        /scope_violation/,
      );
      await assert.rejects(
        repo.transaction(scope, (tx) =>
          tx.configuration.schedules.list({ limit: 0 }),
        ),
        /invalid_page/,
      );
    },
  );
  scenario(
    "saved gap previews are immutable and stale revisions cannot activate",
    async (repo, scope) => {
      const { value, preview, policy } = await seed(repo, scope);
      assert.equal(preview.intervals[0].assignment, null);
      await repo.transaction(scope, async (tx) => {
        assert.equal(
          (await tx.configuration.previews.forSchedule(value.id, { limit: 10 }))
            .items.length,
          1,
        );
        await tx.configuration.schedules.put({ ...value, version: 2 }, 1);
      });
      await assert.rejects(
        repo.transaction(scope, (tx) =>
          tx.configuration.policies.put({ ...policy, version: 2 }, 1),
        ),
        /stale_preview/,
      );
      await assert.rejects(
        repo.transaction(scope, (tx) =>
          tx.configuration.previews.insert({ ...preview, id: "stale" }),
        ),
        /stale_preview/,
      );
      await repo.transaction(scope, async (tx) => {
        assert.equal(
          (await tx.configuration.previews.get(preview.id))!.scheduleVersion,
          1,
        );
        assert.equal(
          await tx.configuration.policies.put(
            { ...policy, enabled: false, version: 2 },
            1,
          ),
          true,
        );
      });
    },
  );
  scenario(
    "forged previews and missing references poison and roll back the transaction",
    async (repo, scope) => {
      const { preview } = await seed(repo, scope);
      await assert.rejects(
        repo.transaction(scope, async (tx) => {
          const original = (await tx.configuration.schedules.get(
            schedule(scope).id,
          ))!;
          await tx.configuration.schedules.put(
            { ...original, name: "must roll back", version: 2 },
            1,
          );
          try {
            await tx.configuration.previews.insert({
              ...preview,
              id: "forged",
              scheduleVersion: 2,
              createdAt: "2000-01-01T00:00:00.000Z",
            });
          } catch {
            /* still poisoned */
          }
        }),
        /invalid_preview/,
      );
      await repo.transaction(scope, async (tx) =>
        assert.equal(
          (await tx.configuration.schedules.get(schedule(scope).id))!.version,
          1,
        ),
      );
      await assert.rejects(
        repo.transaction(scope, (tx) =>
          tx.configuration.contacts.put(
            configuredContactSchema.parse({
              id: "contact",
              workspaceId: scope,
              version: 1,
              responderId: "primary",
              channel: "webhook",
              secretId: "missing-secret",
              enabled: true,
              priority: 0,
            }),
            null,
          ),
        ),
        /not_found/,
      );
    },
  );
  scenario(
    "configuration handles expire with the physical transaction",
    async (repo, scope) => {
      let escaped!: ConfigurationTransaction;
      await repo.transaction(scope, async (tx) => {
        escaped = tx;
      });
      await assert.rejects(
        escaped.configuration.schedules.list({ limit: 10 }),
        /closed_transaction/,
      );
      await assert.rejects(
        escaped.routing.contacts(
          "primary" as Parameters<typeof escaped.routing.contacts>[0],
        ),
        /closed_transaction/,
      );
    },
  );
}
