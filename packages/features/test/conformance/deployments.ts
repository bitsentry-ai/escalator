import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  configuredPolicySchema,
  scheduleSchema,
  schedulePreviewSchema,
  deploymentTargetSchema,
  deploymentTokenSchema,
  workspaceIdSchema,
  type WorkspaceId,
  type DeploymentEntry,
} from "@bitsentry-escalator/features/contracts";
import {
  startDeployment,
  finishDeployment,
  timeoutDeployment,
  type DeploymentRepository,
  type DeploymentTransaction,
  type DeploymentTransition,
  type ConfigurationRepository,
  type DurableWorkStore,
} from "@bitsentry-escalator/features/application";
import { seedPagingFixture } from "./paging.js";

export interface DeploymentFixture {
  repository: DeploymentRepository;
  configuration: ConfigurationRepository;
  work: DurableWorkStore;
  dispose(): Promise<void>;
}
export const deployFixtureHash = (scope: WorkspaceId) =>
  createHash("sha256").update(scope).digest("hex");
function configuredPolicy(scope: WorkspaceId) {
  return configuredPolicySchema.parse({
    id: "policy",
    workspaceId: scope,
    serviceId: "api",
    version: 1,
    primaryScheduleId: "primary",
    peerScheduleId: "primary",
    fallbackResponderIds: ["peer"],
    steps: [{ id: "initial", offsetMs: 0, target: "primary" }],
    terminal: {
      reminderIntervalMs: 60000,
      maxReminders: 1,
      action: "notify_operator",
      notifyResponderIds: ["peer"],
    },
    enabled: true,
    primaryPreviewId: "preview",
    peerPreviewId: "preview",
  });
}
export async function seedDeploymentFixture(
  fixture: DeploymentFixture,
  scope: WorkspaceId,
) {
  await fixture.configuration.transaction(scope, async (tx) => {
    await seedPagingFixture(tx);
    await tx.configuration.schedules.put(
      scheduleSchema.parse({
        id: "primary",
        workspaceId: scope,
        serviceId: "api",
        name: "Primary",
        version: 1,
        enabled: true,
        rotations: [],
        overrides: [],
      }),
      null,
    );
    const endsAt = new Date(Date.parse(tx.now) + 3600000).toISOString();
    await tx.configuration.previews.insert(
      schedulePreviewSchema.parse({
        id: "preview",
        workspaceId: scope,
        scheduleId: "primary",
        serviceId: "api",
        scheduleVersion: 1,
        createdAt: tx.now,
        startsAt: tx.now,
        endsAt,
        intervals: [{ startsAt: tx.now, endsAt, assignment: null }],
      }),
    );
    await tx.configuration.policies.put(configuredPolicy(scope), null);
  });
  await fixture.repository.transaction(scope, async (tx) => {
    await tx.targets.insert(
      deploymentTargetSchema.parse({
        id: "target",
        workspaceId: scope,
        serviceId: "api",
        environmentId: "prod",
        name: "Production",
        enabled: true,
        revision: 1,
        timeoutSeconds: 600,
        policyId: "policy",
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
    );
    await tx.tokens.insert(
      deploymentTokenSchema.parse({
        id: "token",
        workspaceId: scope,
        targetId: "target",
        tokenHash: deployFixtureHash(scope),
        capabilities: ["deployment:write"],
        mappedDeployerId: null,
        createdAt: tx.now,
        expiresAt: new Date(Date.parse(tx.now) + 86400000).toISOString(),
        revokedAt: null,
      }),
    );
  });
}
function changed(value: DeploymentTransition) {
  if (value.state !== "changed")
    throw new Error("Expected deployment transition");
  return value.deployment;
}
export async function fixtureDeployment(
  tx: DeploymentTransaction,
  id = "deployment",
  past = false,
): Promise<DeploymentEntry> {
  const target = (await tx.targets.get("target"))!;
  const at = await tx.currentTime();
  const deployment = changed(
    startDeployment(
      undefined,
      {
        version: 1,
        source: "fixture",
        externalId: id,
        environmentId: target.environmentId,
        actor: "untrusted",
        commit: "abc123",
        artifact: null,
        occurredAt: past ? new Date(Date.parse(at) - 900000).toISOString() : at,
      },
      {
        id,
        workspaceId: tx.workspaceId,
        serviceId: target.serviceId,
        environmentId: target.environmentId,
        tokenId: "token",
        mappedDeployerId: null,
        timeoutSeconds: target.timeoutSeconds,
      },
      at,
    ),
  );
  return {
    targetId: target.id,
    deployment,
    policy: await tx.targets.routing(target.id),
  };
}
function finishInput(
  entry: DeploymentEntry,
  at: string,
  outcome: "SUCCEEDED" | "FAILED" = "SUCCEEDED",
) {
  return {
    version: 1 as const,
    source: entry.deployment.source,
    externalId: entry.deployment.externalId,
    environmentId: entry.deployment.environmentId,
    actor: "ci",
    outcome,
    occurredAt: at,
  };
}
async function receipt(tx: DeploymentTransaction, entry: DeploymentEntry) {
  return {
    workspaceId: tx.workspaceId,
    targetId: "target",
    key: "request-1",
    action: "start" as const,
    tokenId: "token",
    requestHash: "a".repeat(64),
    recordedAt: await tx.currentTime(),
    result: {
      state: "accepted" as const,
      deploymentId: entry.deployment.id,
      revision: entry.deployment.revision,
      status: entry.deployment.status,
    },
  };
}
export function deploymentConformance(
  name: string,
  create: () => Promise<DeploymentFixture>,
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
      fixture: DeploymentFixture,
      a: WorkspaceId,
      b: WorkspaceId,
    ) => Promise<void>,
  ) {
    register(`${name}: ${title}`, async () => {
      const fixture = await create();
      const a = workspaceIdSchema.parse(`deploy_${randomUUID()}`),
        b = workspaceIdSchema.parse(`deploy_${randomUUID()}`);
      try {
        for (const scope of [a, b]) await seedDeploymentFixture(fixture, scope);
        await run(fixture, a, b);
      } finally {
        await fixture.dispose();
      }
    });
  }
  scenario(
    "scope isolates deployments, receipts and grants with IDs-only authentication lookup",
    async ({ repository }, a, b) => {
      await repository.transaction(a, async (tx) => {
        const entry = await fixtureDeployment(tx);
        await tx.deployments.insert(entry);
        await tx.receipts.insert(await receipt(tx, entry));
      });
      assert.deepEqual(
        await repository.findTokenContext(deployFixtureHash(a)),
        { workspaceId: a, targetId: "target", id: "token" },
      );
      await repository.transaction(b, async (tx) => {
        assert.equal(
          await tx.deployments.get("target", "deployment"),
          undefined,
        );
        assert.equal(
          await tx.deployments.find("target", "fixture", "deployment"),
          undefined,
        );
        assert.equal(await tx.receipts.get("target", "request-1"), undefined);
        assert.equal(
          await tx.tokens.get("target", deployFixtureHash(a)),
          undefined,
        );
        assert.equal((await tx.targets.get("target"))!.workspaceId, b);
      });
      await assert.rejects(
        repository.transaction(a, async (tx) => {
          const value = (await tx.targets.get("target"))!;
          await tx.targets.replace(
            { ...value, workspaceId: b, revision: 2 },
            1,
          );
        }),
        /scope_violation/,
      );
      await assert.rejects(
        repository.transaction(b, async (tx) => {
          const token = (await tx.tokens.get("target", deployFixtureHash(b)))!;
          await tx.tokens.insert({
            ...token,
            id: "collision",
            tokenHash: deployFixtureHash(a),
            createdAt: tx.now,
          });
        }),
        /already_exists/,
      );
    },
  );
  scenario(
    "target natural identity is unique and compare-and-swap has one winner",
    async ({ repository }, scope) => {
      const original = await repository.transaction(
        scope,
        async (tx) => (await tx.targets.get("target"))!,
      );
      const results = await Promise.all(
        ["first", "second"].map((name) =>
          repository.transaction(scope, async (tx) =>
            tx.targets.replace(
              {
                ...original,
                name,
                revision: 2,
                updatedAt: await tx.currentTime(),
              },
              1,
            ),
          ),
        ),
      );
      assert.equal(results.filter(Boolean).length, 1);
      await assert.rejects(
        repository.transaction(scope, async (tx) =>
          tx.targets.insert({
            ...original,
            id: "duplicate",
            createdAt: tx.now,
            updatedAt: tx.now,
          }),
        ),
        /already_exists/,
      );
    },
  );
  scenario(
    "new records cannot forge mapping, routing, deadline or terminal state",
    async ({ repository }, scope) => {
      for (const change of ["mapping", "policy", "deadline", "terminal"]) {
        await assert.rejects(
          repository.transaction(scope, async (tx) => {
            const value = await fixtureDeployment(tx);
            if (change === "mapping")
              value.deployment.mappedDeployerId =
                value.policy.fallbackResponderIds[0];
            if (change === "policy") value.policy.terminal.maxReminders++;
            if (change === "deadline")
              value.deployment.timeoutAt = new Date(
                Date.parse(value.deployment.timeoutAt) + 1000,
              ).toISOString();
            if (change === "terminal")
              value.deployment = changed(
                finishDeployment(
                  value.deployment,
                  finishInput(value, value.deployment.acceptedAt),
                  value.deployment.acceptedAt,
                ),
              );
            await tx.deployments.insert(value);
          }),
          /invalid_transition|identity_change/,
        );
      }
      await repository.transaction(scope, async (tx) =>
        assert.equal(
          await tx.deployments.get("target", "deployment"),
          undefined,
        ),
      );
    },
  );
  scenario(
    "deployment IDs and natural keys never overwrite an earlier start",
    async ({ repository }, scope) => {
      await repository.transaction(scope, async (tx) =>
        tx.deployments.insert(await fixtureDeployment(tx)),
      );
      for (const id of ["deployment", "different-id"])
        await assert.rejects(
          repository.transaction(scope, async (tx) => {
            const value = await fixtureDeployment(tx);
            value.deployment.id = id;
            await tx.deployments.insert(value);
          }),
          /already_exists/,
        );
    },
  );
  scenario(
    "finish compare-and-swap has one winner and rejects forged state",
    async ({ repository }, scope) => {
      const entry = await repository.transaction(scope, async (tx) => {
        const value = await fixtureDeployment(tx);
        await tx.deployments.insert(value);
        return value;
      });
      const results = await Promise.all(
        (["SUCCEEDED", "FAILED"] as const).map((outcome) =>
          repository.transaction(scope, async (tx) => {
            const at = await tx.currentTime();
            const done = changed(
              finishDeployment(
                entry.deployment,
                finishInput(entry, at, outcome),
                at,
              ),
            );
            return tx.deployments.replace("target", done, 1);
          }),
        ),
      );
      assert.equal(results.filter(Boolean).length, 1);
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          const current = (await tx.deployments.get("target", "deployment"))!;
          await tx.deployments.replace(
            "target",
            {
              ...current.deployment,
              actor: "forged",
              revision: 3,
              updatedAt: await tx.currentTime(),
            },
            2,
          );
        }),
        /invalid_transition/,
      );
    },
  );
  scenario(
    "late finish preserves timeout and policy after persistence",
    async ({ repository }, scope) => {
      await repository.transaction(scope, async (tx) =>
        tx.deployments.insert(await fixtureDeployment(tx, "deployment", true)),
      );
      await repository.transaction(scope, async (tx) => {
        const value = (await tx.deployments.get("target", "deployment"))!;
        assert.equal(
          await tx.deployments.replace(
            "target",
            changed(
              timeoutDeployment(value.deployment, await tx.currentTime()),
            ),
            1,
          ),
          true,
        );
      });
      await repository.transaction(scope, async (tx) => {
        const value = (await tx.deployments.get("target", "deployment"))!;
        const at = await tx.currentTime();
        assert.equal(
          await tx.deployments.replace(
            "target",
            changed(
              finishDeployment(value.deployment, finishInput(value, at), at),
            ),
            2,
          ),
          true,
        );
      });
      await repository.transaction(scope, async (tx) => {
        const value = (await tx.deployments.get("target", "deployment"))!;
        assert.equal(value.deployment.status, "TIMED_OUT");
        assert.equal(value.deployment.finish?.outcome, "SUCCEEDED");
        assert.equal(value.deployment.revision, 3);
        assert.equal(value.policy.version, 1);
      });
    },
  );
  scenario(
    "receipts retain original results and reject collisions or fabricated revisions",
    async ({ repository }, scope) => {
      await repository.transaction(scope, async (tx) => {
        const value = await fixtureDeployment(tx);
        await tx.deployments.insert(value);
        await tx.receipts.insert(await receipt(tx, value));
      });
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          const value = (await tx.receipts.get("target", "request-1"))!;
          await tx.receipts.insert({
            ...value,
            recordedAt: await tx.currentTime(),
            requestHash: "b".repeat(64),
          });
        }),
        /already_exists/,
      );
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          const value = (await tx.deployments.get("target", "deployment"))!;
          const row = await receipt(tx, value);
          await tx.receipts.insert({
            ...row,
            key: "forged",
            result: { ...row.result, revision: 99 },
          });
        }),
        /invalid_receipt/,
      );
      await repository.transaction(scope, async (tx) => {
        const value = (await tx.deployments.get("target", "deployment"))!;
        const at = await tx.currentTime();
        await tx.deployments.replace(
          "target",
          changed(
            finishDeployment(value.deployment, finishInput(value, at), at),
          ),
          1,
        );
      });
      await repository.transaction(scope, async (tx) => {
        const saved = (await tx.receipts.get("target", "request-1"))!;
        assert.equal(saved.requestHash, "a".repeat(64));
        assert.deepEqual(saved.result, {
          state: "accepted",
          deploymentId: "deployment",
          revision: 1,
          status: "STARTED",
        });
      });
    },
  );
  scenario(
    "deployment, receipt, durable work and audit roll back together",
    async ({ repository, work }, scope) => {
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          const value = await fixtureDeployment(tx);
          await tx.deployments.insert(value);
          await tx.receipts.insert(await receipt(tx, value));
          await tx.work.enqueue("job", {
            id: "rollback-job",
            kind: "deploy.timeout",
            idempotencyKey: "rollback-job",
            payload: {},
            dueAt: tx.now,
          });
          await tx.audit.append({
            id: "rollback-audit",
            workspaceId: scope,
            actor: { kind: "system", component: "deploy" },
            action: "deployment.started",
            subjectType: "deployment",
            subjectId: "deployment",
            recordedAt: tx.now,
            metadata: {},
          });
          throw new Error("rollback requested");
        }),
        /rollback requested/,
      );
      await repository.transaction(scope, async (tx) => {
        assert.equal(
          await tx.deployments.get("target", "deployment"),
          undefined,
        );
        assert.equal(await tx.receipts.get("target", "request-1"), undefined);
        assert.equal((await tx.audit.list({ limit: 10 })).items.length, 0);
      });
      assert.equal(
        await work.claim({
          queue: "job",
          workspaceId: scope,
          token: randomUUID(),
          leaseMs: 60000,
          kinds: ["deploy.timeout"],
        }),
        undefined,
      );
    },
  );
  scenario(
    "caught storage errors poison transactions and escaped handles close",
    async ({ repository }, scope) => {
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          await tx.deployments.insert(await fixtureDeployment(tx));
          await assert.rejects(tx.targets.list({ limit: 0 }), /invalid_page/);
        }),
        /invalid_page/,
      );
      const escaped = await repository.transaction(scope, async (tx) => {
        assert.equal(
          await tx.deployments.get("target", "deployment"),
          undefined,
        );
        return tx;
      });
      await assert.rejects(escaped.targets.get("target"), /closed_transaction/);
      await assert.rejects(
        escaped.tokens.get("target", deployFixtureHash(scope)),
        /closed_transaction/,
      );
      await assert.rejects(
        escaped.deployments.get("target", "deployment"),
        /closed_transaction/,
      );
      await assert.rejects(
        escaped.receipts.get("target", "request-1"),
        /closed_transaction/,
      );
    },
  );
  scenario(
    "routing is read in transaction and disabling a policy preserves historical snapshots",
    async ({ repository, configuration }, scope) => {
      const original = await repository.transaction(scope, async (tx) => {
        const entry = await fixtureDeployment(tx);
        await tx.deployments.insert(entry);
        return entry;
      });
      await configuration.transaction(scope, async (tx) => {
        const policy = (await tx.configuration.policies.get("policy"))!;
        await tx.configuration.policies.put(
          { ...policy, version: 2, enabled: false },
          1,
        );
      });
      await assert.rejects(
        repository.transaction(scope, (tx) => tx.targets.routing("target")),
        /not_found/,
      );
      await repository.transaction(scope, async (tx) => {
        assert.deepEqual(
          await tx.deployments.get("target", "deployment"),
          original,
        );
      });
    },
  );
  scenario(
    "revocation and target/policy edits preserve existing deployment snapshots",
    async (fixture, scope) => {
      const { repository, configuration } = fixture;
      const original = await repository.transaction(scope, async (tx) => {
        const value = await fixtureDeployment(tx);
        await tx.deployments.insert(value);
        return value;
      });
      await repository.transaction(scope, async (tx) => {
        assert.equal(await tx.tokens.revoke("target", "token"), true);
        const first = (await tx.tokens.get("target", deployFixtureHash(scope)))!
          .revokedAt;
        assert.equal(await tx.tokens.revoke("target", "token"), true);
        assert.equal(
          (await tx.tokens.get("target", deployFixtureHash(scope)))!.revokedAt,
          first,
        );
        const target = (await tx.targets.get("target"))!;
        await tx.targets.replace(
          {
            ...target,
            timeoutSeconds: 3600,
            revision: 2,
            updatedAt: await tx.currentTime(),
          },
          1,
        );
      });
      await configuration.transaction(scope, async (tx) => {
        const value = (await tx.configuration.policies.get("policy"))!;
        await tx.configuration.policies.put(
          {
            ...value,
            version: 2,
            terminal: { ...value.terminal, maxReminders: 2 },
          },
          1,
        );
      });
      await repository.transaction(scope, async (tx) =>
        assert.deepEqual(
          await tx.deployments.get("target", "deployment"),
          original,
        ),
      );
    },
  );
}
