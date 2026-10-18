import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  signalSourceSchema,
  signalEventSchema,
  type WorkspaceId,
  type AlertGroup,
} from "@bitsentry-escalator/features/contracts";
import {
  transitionAlert,
  type DetectionRepository,
  type DetectionTransaction,
  type DurableWorkStore,
} from "@bitsentry-escalator/features/application";
import { seedPagingFixture } from "./paging.js";
export async function seedDetectionFixture(tx: DetectionTransaction) {
  await seedPagingFixture(tx);
  await tx.sources.insert(
    signalSourceSchema.parse({
      id: "source",
      workspaceId: tx.workspaceId,
      serviceId: "api",
      environmentId: "prod",
      name: "Errors",
      kind: "generic",
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
  const signal = signalEventSchema.parse({
    id: "event",
    eventId: "event",
    version: 1,
    workspaceId: tx.workspaceId,
    sourceId: "source",
    serviceId: "api",
    environmentId: "prod",
    observedAt: tx.now,
    receivedAt: tx.now,
    status: "active",
    severity: "high",
    fingerprint: "errors",
    title: "Errors",
    evidence: { summary: "HTTP 500", attributes: [] },
  });
  await tx.signals.insert(signal);
}
export async function detectionRows(tx: DetectionTransaction) {
  const signal = (await tx.signals.get("event"))!;
  const source = (await tx.sources.get("source"))!;
  const decision = transitionAlert(undefined, signal, source, tx.now);
  if (decision.state !== "changed") throw new Error("Expected alert");
  const alert = decision.alert;
  const group: AlertGroup = {
    id: alert.groupKey,
    workspaceId: tx.workspaceId,
    serviceId: alert.serviceId,
    environmentId: alert.environmentId,
    incidentId: null,
    recoveryJobId: null,
    revision: 1,
  };
  return { alert, group };
}
export interface DetectionFixture {
  repository: DetectionRepository;
  work: DurableWorkStore;
  dispose(): Promise<void>;
}
export function detectionConformance(
  name: string,
  create: () => Promise<DetectionFixture>,
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
      fixture: DetectionFixture,
      a: WorkspaceId,
      b: WorkspaceId,
    ) => Promise<void>,
  ) {
    register(`${name}: ${title}`, async () => {
      const fixture = await create();
      const a = workspaceIdSchema.parse(`detection_a_${randomUUID()}`);
      const b = workspaceIdSchema.parse(`detection_b_${randomUUID()}`);
      try {
        for (const scope of [a, b])
          await fixture.repository.transaction(scope, seedDetectionFixture);
        await run(fixture, a, b);
      } finally {
        await fixture.dispose();
      }
    });
  }
  scenario(
    "alert, group, receipt, audit and work roll back together",
    async ({ repository, work }, scope) => {
      const ids = await repository.transaction(scope, detectionRows);
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          await tx.detection.lockGroup(ids.group.id);
          await tx.detection.putGroup(ids.group, null);
          await tx.detection.putAlert(ids.alert);
          await tx.detection.recordProcessed({
            id: "event",
            workspaceId: scope,
            sourceId: "source",
            incidentId: null,
            disposition: "active",
            recordedAt: tx.now,
          });
          await tx.work.enqueue("job", {
            id: "fixture-job",
            kind: "signal.process",
            idempotencyKey: "fixture-job",
            payload: { signalId: "event" },
            dueAt: tx.now,
          });
          await tx.audit.append({
            id: "fixture-audit",
            workspaceId: scope,
            actor: { kind: "system", component: "detection" },
            action: "signal.processed",
            subjectType: "signal",
            subjectId: "event",
            recordedAt: tx.now,
            metadata: {},
          });
          throw new Error("abort transaction");
        }),
        /abort transaction/,
      );
      await repository.transaction(scope, async (tx) => {
        assert.equal(await tx.detection.lockGroup(ids.group.id), undefined);
        assert.equal(await tx.detection.alert(ids.alert.id), undefined);
        assert.equal(await tx.detection.processed("event"), undefined);
        assert.equal(
          (await tx.audit.list({ limit: 100 })).items.some(
            (row) => row.id === "fixture-audit",
          ),
          false,
        );
      });
      assert.equal(
        await work.claim({
          workspaceId: scope,
          queue: "job",
          token: "fixture-claim",
          leaseMs: 30000,
          kinds: ["signal.process"],
        }),
        undefined,
      );
    },
  );
  scenario(
    "missing-group creation has one compare-and-swap winner",
    async ({ repository }, scope) => {
      const { group } = await repository.transaction(scope, detectionRows);
      const results = await Promise.all(
        [1, 2].map(() =>
          repository.transaction(scope, async (tx) => {
            await tx.sources.get("source");
            await tx.detection.lockGroup(group.id);
            return tx.detection.putGroup(group, null);
          }),
        ),
      );
      assert.equal(results.filter(Boolean).length, 1);
    },
  );
  scenario(
    "foreign alerts, groups and receipts are indistinguishable from missing records",
    async ({ repository }, scope, other) => {
      const { alert, group } = await repository.transaction(
        scope,
        detectionRows,
      );
      await repository.transaction(scope, async (tx) => {
        await tx.detection.lockGroup(group.id);
        await tx.detection.putGroup(group, null);
        await tx.detection.putAlert(alert);
        await tx.detection.recordProcessed({
          id: "event",
          workspaceId: scope,
          sourceId: "source",
          incidentId: null,
          disposition: "active",
          recordedAt: tx.now,
        });
      });
      await repository.transaction(other, async (tx) => {
        assert.equal(await tx.detection.lockGroup(group.id), undefined);
        assert.equal(await tx.detection.alert(alert.id), undefined);
        assert.equal(await tx.detection.processed("event"), undefined);
      });
      await assert.rejects(
        repository.transaction(other, (tx) => tx.detection.putAlert(alert)),
        { code: "scope_violation" },
      );
    },
  );
  scenario(
    "caught scope failures poison all prior writes and closed handles cannot be reused",
    async ({ repository }, scope, other) => {
      const { group, alert } = await repository.transaction(
        scope,
        detectionRows,
      );
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          await tx.detection.lockGroup(group.id);
          await tx.detection.putGroup(group, null);
          try {
            await tx.detection.putAlert({ ...alert, workspaceId: other });
          } catch {
            /* guard must still abort commit */
          }
        }),
        { code: "scope_violation" },
      );
      const handle = await repository.transaction(scope, async (tx) => {
        assert.equal(await tx.detection.lockGroup(group.id), undefined);
        return tx.detection;
      });
      await assert.rejects(handle.processed("event"), {
        code: "closed_transaction",
      });
    },
  );
  scenario(
    "a processing receipt cannot be overwritten after a crash before job settlement",
    async ({ repository }, scope) => {
      await repository.transaction(scope, (tx) =>
        tx.detection.recordProcessed({
          id: "event",
          workspaceId: scope,
          sourceId: "source",
          incidentId: null,
          disposition: "stale",
          recordedAt: tx.now,
        }),
      );
      await assert.rejects(
        repository.transaction(scope, (tx) =>
          tx.detection.recordProcessed({
            id: "event",
            workspaceId: scope,
            sourceId: "source",
            incidentId: null,
            disposition: "active",
            recordedAt: tx.now,
          }),
        ),
      );
      await repository.transaction(scope, async (tx) =>
        assert.equal(
          (await tx.detection.processed("event"))?.disposition,
          "stale",
        ),
      );
    },
  );
}
