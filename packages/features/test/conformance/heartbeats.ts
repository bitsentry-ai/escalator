import test, { type TestOptions } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  heartbeatSchema,
  heartbeatGrantSchema,
  signalSourceSchema,
  workspaceIdSchema,
} from "@bitsentry-escalator/features/contracts";
import {
  HeartbeatIntake,
  heartbeatTokenHash,
  configureHeartbeat,
  writeHeartbeatDeadline,
  type HeartbeatRepository,
  type HeartbeatTransaction,
} from "@bitsentry-escalator/features/application";
import { seedSignalFixture } from "./signals.js";
export interface HeartbeatFixture {
  repository: HeartbeatRepository;
  dispose(): Promise<void>;
}
export const heartbeatTestToken = `ehb_${"A".repeat(43)}`;
export async function seedHeartbeatFixture(
  tx: HeartbeatTransaction,
  hash = heartbeatTokenHash(heartbeatTestToken),
) {
  await seedSignalFixture(tx);
  await tx.sources.insert(
    signalSourceSchema.parse({
      id: "heartbeat-source",
      workspaceId: tx.workspaceId,
      serviceId: "service",
      environmentId: "production",
      name: "Cron",
      kind: "heartbeat",
      enabled: true,
      version: 1,
      grouping: "source-fingerprint",
      recovery: "explicit",
      recoveryHoldSeconds: 60,
      authSecretId: null,
      createdAt: tx.now,
      updatedAt: tx.now,
    }),
  );
  const probe = heartbeatSchema.parse({
    id: "heartbeat",
    workspaceId: tx.workspaceId,
    sourceId: "heartbeat-source",
    serviceId: "service",
    environmentId: "production",
    name: "Cron",
    enabled: true,
    intervalSeconds: 60,
    graceSeconds: 10,
    version: 1,
    createdAt: tx.now,
    updatedAt: tx.now,
  });
  assert.equal(await tx.heartbeats.put(probe, null), true);
  const initial = configureHeartbeat(probe, undefined, tx.now);
  await tx.heartbeats.putState(initial);
  await writeHeartbeatDeadline(tx, initial);
  await tx.heartbeats.insertGrant(
    heartbeatGrantSchema.parse({
      id: "grant",
      workspaceId: tx.workspaceId,
      probeId: probe.id,
      tokenHash: hash,
      scope: "heartbeat:write",
      createdAt: tx.now,
      expiresAt: new Date(Date.parse(tx.now) + 3600000).toISOString(),
      revokedAt: null,
    }),
  );
  return probe;
}
export function heartbeatConformance(
  name: string,
  create: () => Promise<HeartbeatFixture>,
  options: TestOptions & {
    register?: (name: string, run: () => Promise<void>) => void;
  } = {},
) {
  const register =
    options.register ??
    ((title: string, run: () => Promise<void>) => test(title, options, run));
  const check = (title: string, run: (f: HeartbeatFixture) => Promise<void>) =>
    register(`${name}: ${title}`, async () => {
      const f = await create();
      try {
        await run(f);
      } finally {
        await f.dispose();
      }
    });
  check(
    "ping receipts are idempotent and tenant context comes only from the grant",
    async ({ repository }) => {
      const scope = workspaceIdSchema.parse(randomUUID());
      const probe = await repository.transaction(scope, seedHeartbeatFixture);
      const intake = new HeartbeatIntake(repository, (id) => id === scope);
      const ping = {
        version: 1 as const,
        eventId: "ping-one",
        observedAt: probe.createdAt,
      };
      const first = await intake.accept(probe.id, heartbeatTestToken, ping);
      assert.equal(first.state, "accepted");
      assert.deepEqual(
        await intake.accept(probe.id, heartbeatTestToken, ping),
        { ...first, state: "duplicate" },
      );
      await repository.transaction(scope, async (tx) => {
        assert.equal((await tx.heartbeats.state(probe.id))?.generation, 2);
        assert.equal(
          (await tx.audit.list({ limit: 100 })).items.filter(
            (row) => row.action === "heartbeat.received",
          ).length,
          1,
        );
      });
      await assert.rejects(
        intake.accept("different-probe", heartbeatTestToken, ping),
        { code: "invalid_token" },
      );
      await assert.rejects(
        new HeartbeatIntake(repository, () => false).accept(
          probe.id,
          heartbeatTestToken,
          ping,
        ),
        { code: "invalid_token" },
      );
      const other = workspaceIdSchema.parse(randomUUID());
      await repository.transaction(other, async (tx) => {
        assert.equal(await tx.heartbeats.get(probe.id), undefined);
        assert.equal(
          await tx.heartbeats.grantByHash(
            heartbeatTokenHash(heartbeatTestToken),
          ),
          undefined,
        );
      });
    },
  );
  check(
    "revocation rejects fresh and replayed pings without advancing deadlines",
    async ({ repository }) => {
      const scope = workspaceIdSchema.parse(randomUUID());
      const probe = await repository.transaction(scope, seedHeartbeatFixture);
      const intake = new HeartbeatIntake(repository, () => true);
      const ping = {
        version: 1 as const,
        eventId: "ping",
        observedAt: probe.createdAt,
      };
      await intake.accept(probe.id, heartbeatTestToken, ping);
      await repository.transaction(scope, async (tx) => {
        await tx.heartbeats.lock(probe.id);
        await tx.heartbeats.revokeGrant(probe.id, "grant");
      });
      await assert.rejects(intake.accept(probe.id, heartbeatTestToken, ping), {
        code: "invalid_token",
      });
      await repository.transaction(scope, async (tx) =>
        assert.equal((await tx.heartbeats.state(probe.id))?.generation, 2),
      );
    },
  );
  check(
    "caught scope errors poison the transaction and escaped handles close",
    async ({ repository }) => {
      const scope = workspaceIdSchema.parse(randomUUID());
      const probe = await repository.transaction(scope, seedHeartbeatFixture);
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          try {
            await tx.heartbeats.put(
              {
                ...probe,
                workspaceId: workspaceIdSchema.parse("foreign"),
                version: 2,
                updatedAt: tx.now,
              },
              1,
            );
          } catch {
            /* A caught failure must still roll back. */
          }
        }),
        { code: "scope_violation" },
      );
      let escaped!: HeartbeatTransaction;
      await repository.transaction(scope, async (tx) => {
        escaped = tx;
      });
      await assert.rejects(escaped.heartbeats.get(probe.id), {
        code: "closed_transaction",
      });
    },
  );
  check(
    "state cannot fabricate recovery and failed configuration work rolls back",
    async ({ repository }) => {
      const scope = workspaceIdSchema.parse(randomUUID());
      const probe = await repository.transaction(scope, seedHeartbeatFixture);
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          await tx.heartbeats.lock(probe.id);
          const state = (await tx.heartbeats.state(probe.id))!;
          await tx.heartbeats.putState({
            ...state,
            generation: 2,
            lastAcceptedAt: tx.now,
            lastObservedAt: tx.now,
          });
        }),
        { code: "invalid_state" },
      );
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          await tx.heartbeats.put(
            { ...probe, version: 2, updatedAt: tx.now, name: "Changed" },
            1,
          );
          throw new Error("rollback");
        }),
        /rollback/,
      );
      await repository.transaction(scope, async (tx) =>
        assert.equal((await tx.heartbeats.get(probe.id))?.version, 1),
      );
      const failing = new HeartbeatIntake(
        {
          findGrantContext: (hash) => repository.findGrantContext(hash),
          transaction: (id, run) =>
            repository.transaction(id, async (tx) => {
              await run(tx);
              throw new Error("after ping rollback");
            }),
        },
        () => true,
      );
      const ping = {
        version: 1 as const,
        eventId: "rolled-back",
        observedAt: probe.createdAt,
      };
      await assert.rejects(
        failing.accept(probe.id, heartbeatTestToken, ping),
        /after ping rollback/,
      );
      await repository.transaction(scope, async (tx) => {
        assert.equal(
          await tx.heartbeats.receipt(probe.id, ping.eventId),
          undefined,
        );
        assert.equal((await tx.heartbeats.state(probe.id))?.generation, 1);
        assert.equal((await tx.audit.list({ limit: 100 })).items.length, 0);
      });
    },
  );
}
