import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  responderIdSchema,
  scheduleIdSchema,
  availabilitySchema,
  configuredContactSchema,
  responderSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import {
  coverageDecision,
  evaluateDeploymentCoverage,
  type CoverageRepository,
  type CoverageTransaction,
  type CoverageRecord,
} from "@bitsentry-escalator/features/application";
import {
  seedDeploymentFixture,
  type DeploymentFixture,
} from "./deployments.js";
export interface CoverageFixture extends DeploymentFixture {
  repository: CoverageRepository;
  providerSecret(scope: WorkspaceId): Promise<string>;
}
export async function seedCoverageFixture(
  fixture: CoverageFixture,
  scope: WorkspaceId,
) {
  await seedDeploymentFixture(fixture, scope);
  const secretId = await fixture.providerSecret(scope);
  await fixture.configuration.transaction(scope, async (tx) => {
    for (const id of ["primary", "peer"]) {
      await tx.configuration.availability.put(
        availabilitySchema.parse({
          id,
          workspaceId: scope,
          version: 1,
          timeZone: "UTC",
          windows: [
            {
              weekdays: [1, 2, 3, 4, 5, 6, 7],
              startMinute: 0,
              endMinute: 1440,
            },
          ],
        }),
        null,
      );
      await tx.configuration.contacts.put(
        configuredContactSchema.parse({
          id: `contact-${id}`,
          workspaceId: scope,
          version: 1,
          responderId: id,
          channel: "webhook",
          secretId,
          enabled: true,
          priority: 0,
        }),
        null,
      );
    }
    await tx.responders.insert(
      responderSchema.parse({
        id: "operator",
        workspaceId: scope,
        hostUserId: "operator",
        displayName: "Operator",
        timeZone: "UTC",
        role: "administrator",
        enabled: true,
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
    );
  });
}
export async function fixtureCoverage(
  tx: CoverageTransaction,
  id = "decision",
  key = "preflight",
): Promise<CoverageRecord> {
  const target = (await tx.targets.get("target"))!;
  const binding = {
    workspaceId: tx.workspaceId,
    targetId: target.id,
    targetRevision: target.revision,
    policyId: target.policyId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
    source: "ci",
    externalId: "42",
    mappedDeployerId: responderIdSchema.parse("primary"),
  };
  const snapshot = await tx.coverage.snapshot(
    target.id,
    binding.mappedDeployerId,
  );
  const now = await tx.currentTime();
  return {
    decision: coverageDecision({
      id,
      binding,
      evaluation: evaluateDeploymentCoverage(snapshot, binding, now),
      now,
    }),
    key,
    requestHash: "a".repeat(64),
  };
}
export function coverageConformance(
  name: string,
  create: () => Promise<CoverageFixture>,
  options: {
    skip?: string;
    register?: (title: string, run: () => Promise<void>) => unknown;
  } = {},
) {
  const register =
    options.register ??
    ((title, run) => test(title, { skip: options.skip }, run));
  function scenario(
    title: string,
    run: (
      fixture: CoverageFixture,
      a: WorkspaceId,
      b: WorkspaceId,
    ) => Promise<void>,
  ) {
    register(`${name}: ${title}`, async () => {
      const fixture = await create();
      const a = workspaceIdSchema.parse(`coverage_${randomUUID()}`),
        b = workspaceIdSchema.parse(`coverage_${randomUUID()}`);
      try {
        for (const scope of [a, b]) await seedCoverageFixture(fixture, scope);
        await run(fixture, a, b);
      } finally {
        await fixture.dispose();
      }
    });
  }
  scenario(
    "scope isolates decisions, keys and private evidence",
    async ({ repository }, a, b) => {
      let saved!: CoverageRecord;
      await repository.transaction(a, async (tx) => {
        saved = await fixtureCoverage(tx);
        assert.equal(saved.decision.evaluation.decision, "allow");
        assert.deepEqual(saved.decision.evaluation.eligibleResponderIds, [
          "peer",
        ]);
        await tx.coverage.insert(saved);
      });
      await repository.transaction(b, async (tx) => {
        assert.equal(await tx.coverage.get("target", "decision"), undefined);
        assert.equal(await tx.coverage.find("target", "preflight"), undefined);
        const snapshot = await tx.coverage.snapshot(
          "target",
          responderIdSchema.parse("primary"),
        );
        assert.ok(snapshot.responders.every((row) => row.workspaceId === b));
        assert.ok(snapshot.contacts.every((row) => row.workspaceId === b));
      });
      await assert.rejects(
        repository.transaction(b, (tx) => tx.coverage.insert(saved)),
        /scope_violation/,
      );
      await repository.transaction(a, async (tx) =>
        assert.deepEqual(await tx.coverage.find("target", "preflight"), saved),
      );
    },
  );
  scenario(
    "IDs and command keys are append-only with one concurrent winner",
    async ({ repository }, scope) => {
      const attempts = await Promise.allSettled(
        [1, 2].map(() =>
          repository.transaction(scope, async (tx) =>
            tx.coverage.insert(await fixtureCoverage(tx)),
          ),
        ),
      );
      assert.equal(
        attempts.filter((row) => row.status === "fulfilled").length,
        1,
      );
      assert.match(
        String(
          (
            attempts.find(
              (row) => row.status === "rejected",
            ) as PromiseRejectedResult
          ).reason,
        ),
        /already_exists/,
      );
      for (const [id, key] of [
        ["decision", "new-key"],
        ["new-id", "preflight"],
      ]) {
        await assert.rejects(
          repository.transaction(scope, async (tx) =>
            tx.coverage.insert(await fixtureCoverage(tx, id, key)),
          ),
          /already_exists/,
        );
      }
      await repository.transaction(scope, async (tx) => {
        assert.equal(
          (await tx.coverage.get("target", "decision"))!.requestHash,
          "a".repeat(64),
        );
        assert.equal(await tx.coverage.get("target", "new-id"), undefined);
        assert.equal(await tx.coverage.find("target", "new-key"), undefined);
      });
    },
  );
  scenario(
    "proofs and audit writes share the rollback boundary",
    async ({ repository }, scope) => {
      const before = await repository.transaction(scope, async (tx) =>
        tx.audit.list({ limit: 100 }),
      );
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          await tx.coverage.insert(await fixtureCoverage(tx));
          await tx.audit.append({
            id: "coverage-audit",
            workspaceId: scope,
            actor: { kind: "system", component: "deploy" },
            action: "deployment.coverage_evaluated",
            subjectType: "deployment",
            subjectId: "42",
            recordedAt: tx.now,
            metadata: {},
          });
          throw new Error("rollback requested");
        }),
        /rollback requested/,
      );
      await repository.transaction(scope, async (tx) => {
        assert.equal(await tx.coverage.get("target", "decision"), undefined);
        assert.deepEqual(await tx.audit.list({ limit: 100 }), before);
      });
    },
  );
  scenario(
    "caught validation and uniqueness failures poison earlier writes",
    async ({ repository }, scope) => {
      for (const duplicate of [false, true]) {
        await assert.rejects(
          repository.transaction(scope, async (tx) => {
            const value = await fixtureCoverage(tx);
            await tx.coverage.insert(value);
            if (duplicate)
              await assert.rejects(tx.coverage.insert(value), /already_exists/);
            else
              await assert.rejects(
                tx.coverage.insert({
                  ...value,
                  key: "forged",
                  decision: {
                    ...value.decision,
                    id: "forged",
                    evaluation: {
                      ...value.decision.evaluation,
                      fingerprint: "0".repeat(64),
                    },
                  },
                }),
                /invalid_coverage/,
              );
          }),
          /invalid_coverage|already_exists/,
        );
        await repository.transaction(scope, async (tx) =>
          assert.equal(await tx.coverage.get("target", "decision"), undefined),
        );
      }
    },
  );
  scenario(
    "captured evidence cannot be mutated by callers",
    async ({ repository }, scope) => {
      await repository.transaction(scope, async (tx) => {
        const snapshot = await tx.coverage.snapshot(
          "target",
          responderIdSchema.parse("primary"),
        );
        snapshot.policy!.enabled = false;
        snapshot.contacts.length = 0;
        snapshot.responders[0].enabled = false;
        const fresh = await tx.coverage.snapshot(
          "target",
          responderIdSchema.parse("primary"),
        );
        assert.equal(fresh.policy!.enabled, true);
        assert.equal(fresh.contacts.length, 2);
        assert.ok(fresh.responders.every((row) => row.enabled));
        const value = await fixtureCoverage(tx);
        assert.equal(value.decision.evaluation.decision, "allow");
        await tx.coverage.insert(value);
        value.decision.evaluation.eligibleResponderIds.length = 0;
      });
      await repository.transaction(scope, async (tx) =>
        assert.deepEqual(
          (await tx.coverage.get("target", "decision"))!.decision.evaluation
            .eligibleResponderIds,
          ["peer"],
        ),
      );
    },
  );
  scenario(
    "target revision changes invalidate new proofs while old receipts remain readable",
    async ({ repository }, scope) => {
      await repository.transaction(scope, async (tx) =>
        tx.coverage.insert(await fixtureCoverage(tx)),
      );
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          const value = await fixtureCoverage(tx, "new-id", "new-key");
          const target = (await tx.targets.get("target"))!;
          assert.equal(
            await tx.targets.replace(
              {
                ...target,
                revision: 2,
                name: "Changed",
                updatedAt: await tx.currentTime(),
              },
              1,
            ),
            true,
          );
          await tx.coverage.insert(value);
        }),
        /stale_coverage/,
      );
      await repository.transaction(scope, async (tx) => {
        const target = (await tx.targets.get("target"))!;
        assert.equal(target.revision, 1);
        assert.equal(
          await tx.targets.replace(
            {
              ...target,
              revision: 2,
              name: "Changed",
              updatedAt: await tx.currentTime(),
            },
            1,
          ),
          true,
        );
      });
      await repository.transaction(scope, async (tx) =>
        assert.equal(
          (await tx.coverage.get("target", "decision"))!.decision.binding
            .targetRevision,
          1,
        ),
      );
    },
  );
  scenario(
    "override requires a currently authorized scoped responder",
    async ({ repository }, scope) => {
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          const value = await fixtureCoverage(tx);
          value.decision.override = {
            responderId: responderIdSchema.parse("primary"),
            reason: "Emergency",
          };
          await tx.coverage.insert(value);
        }),
        /forbidden/,
      );
      await repository.transaction(scope, async (tx) => {
        const value = await fixtureCoverage(tx);
        value.decision.override = {
          responderId: responderIdSchema.parse("operator"),
          reason: "Emergency response",
        };
        await tx.coverage.insert(value);
      });
      await repository.transaction(scope, async (tx) =>
        assert.equal(
          (await tx.coverage.get("target", "decision"))!.decision.override!
            .responderId,
          "operator",
        ),
      );
    },
  );
  scenario(
    "oversized relevant rosters block instead of certifying truncated evidence",
    async ({ repository, configuration }, scope) => {
      await configuration.transaction(scope, async (tx) => {
        const ids = [];
        for (let n = 0; n < 104; n++) {
          const id = responderIdSchema.parse(
            `extra-${String(n).padStart(3, "0")}`,
          );
          ids.push(id);
          await tx.responders.insert(
            responderSchema.parse({
              id,
              workspaceId: scope,
              hostUserId: id,
              displayName: id,
              timeZone: "UTC",
              role: "responder",
              enabled: true,
              createdAt: tx.now,
              updatedAt: tx.now,
            }),
          );
        }
        const schedule = (await tx.configuration.schedules.get(
          scheduleIdSchema.parse("primary"),
        ))!;
        const rotation = {
          timeZone: "UTC",
          anchorLocal: "2026-01-01T00:00",
          shiftDays: 1,
          disambiguation: "compatible" as const,
          until: null,
        };
        assert.equal(
          await tx.configuration.schedules.put(
            {
              ...schedule,
              version: 2,
              rotations: [
                {
                  ...rotation,
                  id: "large",
                  priority: 0,
                  responders: ids.slice(0, 100),
                },
                {
                  ...rotation,
                  id: "rest",
                  priority: 1,
                  responders: ids.slice(100),
                },
              ],
            },
            1,
          ),
          true,
        );
      });
      await repository.transaction(scope, async (tx) => {
        const snapshot = await tx.coverage.snapshot(
          "target",
          responderIdSchema.parse("primary"),
        );
        assert.equal(snapshot.complete, false);
        assert.ok(snapshot.responders.length <= 103);
        const value = await fixtureCoverage(tx);
        assert.equal(value.decision.evaluation.decision, "block");
        assert.equal(
          value.decision.evaluation.reason,
          "configuration_unavailable",
        );
        await tx.coverage.insert(value);
      });
    },
  );
  scenario(
    "escaped handles cannot read or write after the transaction",
    async ({ repository }, scope) => {
      const tx = await repository.transaction(scope, async (tx) => tx);
      await assert.rejects(
        tx.coverage.snapshot("target", null),
        /closed_transaction/,
      );
      await assert.rejects(
        tx.coverage.get("target", "decision"),
        /closed_transaction/,
      );
      await assert.rejects(
        tx.coverage.find("target", "preflight"),
        /closed_transaction/,
      );
    },
  );
}
