import assert from "node:assert/strict";
import type {
  InvestigationClaim,
  InvestigationIntent,
  InvestigationIntentWriter,
  InvestigationRepository,
  InvestigationRunResult,
  InvestigationTraceEvent,
  TraceWriter,
} from "../../src/investigation/ports/index.js";
import {
  serviceIdSchema,
  type InvestigationScope,
} from "../../src/contracts/index.js";
export interface InvestigationPersistenceFixture {
  maxAttempts: number;
  changeConfiguration(kind: "profile" | "source"): Promise<void>;
  intent: InvestigationIntent;
  result: InvestigationRunResult;
  otherScope: InvestigationScope;
  writer: InvestigationIntentWriter;
  repository: InvestigationRepository;
  trace: TraceWriter;
  reopen(): InvestigationRepository;
  /** Force persisted expiry, not the caller's timestamp. */
  expire(claim: InvestigationClaim): Promise<void>;
  /** Host mapping revocation must also fence work already in flight. */
  revokeRuntime(runtimeId: string): Promise<void>;
  traces(): Promise<InvestigationTraceEvent[]>;
  /** A separately reserved DB connection must observe the committed claim. */
  committed(claim: InvestigationClaim): Promise<boolean>;
  dispose(): Promise<void>;
}
type Register = (name: string, run: () => Promise<void>) => void;
export function investigationPersistenceConformance(
  name: string,
  create: () => Promise<InvestigationPersistenceFixture>,
  register: Register,
) {
  const scenario = (
    title: string,
    run: (f: InvestigationPersistenceFixture) => Promise<void>,
  ) =>
    register(`${name}: ${title}`, async () => {
      const f = await create();
      try {
        await run(f);
      } finally {
        await f.dispose();
      }
    });
  const claim = (
    f: InvestigationPersistenceFixture,
    token = "token_a",
    runtimeId = "runtime_a",
  ) =>
    f.repository.claim({
      workspaceId: f.intent.scope.workspaceId,
      runtimeId,
      claimToken: token,
      leaseMs: 30000,
    });
  scenario(
    "enqueue is idempotent without replacing captured scope or configuration",
    async (f) => {
      assert.equal(await f.writer.enqueue(f.intent), "inserted");
      assert.equal(
        await f.writer.enqueue({
          ...f.intent,
          profileId: "replacement",
          limits: { ...f.intent.limits, maxModelCalls: 2 },
        }),
        "duplicate",
      );
      const current = await claim(f);
      assert.ok(current);
      assert.equal(current.profileId, f.intent.profileId);
      assert.deepEqual(current.limits, f.intent.limits);
      assert.deepEqual(current.sources, f.intent.sources);
    },
  );
  scenario(
    "parallel claims have one winner and commit before returning",
    async (f) => {
      await f.writer.enqueue(f.intent);
      const results = await Promise.all([
        claim(f, "token_a"),
        claim(f, "token_b"),
      ]);
      const winners = results.filter(
        (value): value is InvestigationClaim => value !== undefined,
      );
      assert.equal(winners.length, 1);
      assert.equal(await f.committed(winners[0]), true);
      assert.equal(
        await f.reopen().claim({
          workspaceId: f.intent.scope.workspaceId,
          runtimeId: "runtime_a",
          claimToken: "token_c",
          leaseMs: 30000,
        }),
        undefined,
      );
    },
  );
  scenario(
    "workspace isolation covers claiming and human report/evidence reads",
    async (f) => {
      await f.writer.enqueue(f.intent);
      assert.equal(
        await f.repository.claim({
          workspaceId: f.otherScope.workspaceId,
          runtimeId: "runtime_a",
          claimToken: "foreign",
          leaseMs: 30000,
        }),
        undefined,
      );
      const current = await claim(f);
      assert.ok(current);
      assert.equal(await f.repository.publish(current, f.result), true);
      assert.equal(await f.repository.get(f.otherScope, current.id), undefined);
      assert.deepEqual(
        await f.repository.getEvidence(f.otherScope, current.id),
        [],
      );
      assert.equal(
        await f.repository.get(
          {
            ...f.intent.scope,
            serviceId: serviceIdSchema.parse("other_service"),
          },
          current.id,
        ),
        undefined,
      );
    },
  );
  scenario(
    "expired claims cannot renew or publish even before another worker claims",
    async (f) => {
      await f.writer.enqueue(f.intent);
      const current = await claim(f);
      assert.ok(current);
      await f.expire(current);
      assert.equal(
        await f.repository.heartbeat(
          { ...current, leaseExpiresAt: "2099-01-01T00:00:00.000Z" },
          30000,
        ),
        undefined,
      );
      assert.equal(await f.repository.publish(current, f.result), false);
      assert.equal(
        await f.repository.get(current.scope, current.id),
        undefined,
      );
    },
  );
  scenario(
    "reclaim increments attempts and fences the old runtime and token",
    async (f) => {
      await f.writer.enqueue(f.intent);
      const old = await claim(f);
      assert.ok(old);
      await f.expire(old);
      const current = await claim(f, "token_b", "runtime_b");
      assert.ok(current);
      assert.equal(current.attempt, old.attempt + 1);
      assert.equal(await f.repository.publish(old, f.result), false);
      assert.equal(await f.repository.heartbeat(old, 30000), undefined);
      assert.equal(
        await f.repository.publish(
          { ...current, runtimeId: old.runtimeId },
          f.result,
        ),
        false,
      );
      assert.equal(await f.repository.publish(current, f.result), true);
    },
  );
  scenario(
    "runtime revocation prevents renewal and result writes",
    async (f) => {
      await f.writer.enqueue(f.intent);
      const current = await claim(f);
      assert.ok(current);
      await f.revokeRuntime(current.runtimeId);
      assert.equal(await f.repository.heartbeat(current, 30000), undefined);
      assert.equal(await f.repository.publish(current, f.result), false);
    },
  );
  scenario(
    "report and redacted snapshots persist together and survive reopening",
    async (f) => {
      await f.writer.enqueue(f.intent);
      const current = await claim(f);
      assert.ok(current);
      assert.equal(await f.repository.publish(current, f.result), true);
      const reopened = f.reopen();
      assert.deepEqual(
        await reopened.get(current.scope, current.id),
        f.result.report,
      );
      assert.deepEqual(
        await reopened.getEvidence(current.scope, current.id),
        f.result.evidence,
      );
      assert.equal(await reopened.publish(current, f.result), false);
      assert.equal(await claim(f, "token_b"), undefined);
    },
  );
  scenario(
    "caller-supplied limits and query changes cannot authorize different evidence",
    async (f) => {
      await f.writer.enqueue(f.intent);
      const current = await claim(f);
      assert.ok(current);
      const changed = structuredClone(f.result);
      changed.report.usage.modelCalls = current.limits.maxModelCalls + 1;
      const forged = {
        ...current,
        limits: {
          ...current.limits,
          maxModelCalls: changed.report.usage.modelCalls,
        },
      };
      assert.equal(await f.repository.publish(forged, changed), false);
      for (const altered of [
        { ...current, profileId: "other_profile" },
        { ...current, attempt: current.attempt + 1 },
        forged,
      ]) {
        assert.equal(await f.repository.heartbeat(altered, 30000), undefined);
        assert.equal(await f.repository.publish(altered, f.result), false);
      }
      assert.equal(
        await f.repository.get(current.scope, current.id),
        undefined,
      );
      assert.equal(await f.repository.publish(current, f.result), true);
    },
  );
  scenario("reclaimed attempts keep independent trace sequences", async (f) => {
    await f.writer.enqueue(f.intent);
    const first = await claim(f);
    assert.ok(first);
    const event: InvestigationTraceEvent = {
      sequence: 0,
      at: f.result.report.startedAt,
      kind: "started",
      evidenceIds: [],
      usage: {
        modelCalls: 0,
        evidenceReads: 0,
        evidenceBytes: 0,
        outputTokens: 0,
        traceEvents: 1,
        elapsedMs: 0,
      },
    };
    assert.equal(await f.trace.append(first, event), true);
    await f.expire(first);
    const second = await claim(f, "token_b");
    assert.ok(second);
    const later = {
      ...event,
      at: new Date(Date.parse(event.at) + 1).toISOString(),
    };
    assert.equal(await f.trace.append(second, later), true);
    assert.equal(await f.trace.append(first, event), false);
    assert.deepEqual(await f.traces(), [later]);
    assert.equal(await f.repository.publish(second, f.result), true);
  });
  scenario(
    "trace retries are idempotent while conflicting sequences and expired writes fail",
    async (f) => {
      await f.writer.enqueue(f.intent);
      const current = await claim(f);
      assert.ok(current);
      const event: InvestigationTraceEvent = {
        sequence: 0,
        at: f.result.report.startedAt,
        kind: "started",
        evidenceIds: [],
        usage: {
          modelCalls: 0,
          evidenceReads: 0,
          evidenceBytes: 0,
          outputTokens: 0,
          traceEvents: 1,
          elapsedMs: 0,
        },
      };
      assert.equal(await f.trace.append(current, event), true);
      assert.equal(await f.trace.append(current, structuredClone(event)), true);
      assert.equal(
        await f.trace.append(current, { ...event, kind: "finished" }),
        false,
      );
      assert.deepEqual(await f.traces(), [event]);
      await f.expire(current);
      assert.equal(
        await f.trace.append(current, {
          ...event,
          sequence: 1,
          usage: { ...event.usage, traceEvents: 2 },
        }),
        false,
      );
    },
  );
  scenario(
    "total model attempts stay bounded across expired claims and reopening",
    async (f) => {
      await f.writer.enqueue(f.intent);
      for (let attempt = 1; attempt <= f.maxAttempts; attempt++) {
        const current = await claim(f, `attempt_${attempt}`);
        assert.ok(current);
        assert.equal(current.attempt, attempt);
        await f.expire(current);
      }
      assert.equal(
        await f.reopen().claim({
          workspaceId: f.intent.scope.workspaceId,
          runtimeId: "runtime_a",
          claimToken: "over_budget",
          leaseMs: 30000,
        }),
        undefined,
      );
    },
  );
  scenario(
    "a profile changed after enqueue cannot silently replace its captured model",
    async (f) => {
      await f.writer.enqueue(f.intent);
      await f.changeConfiguration("profile");
      assert.equal(await claim(f), undefined);
    },
  );
  scenario(
    "source binding changes revoke an in-flight investigation",
    async (f) => {
      await f.writer.enqueue(f.intent);
      const current = await claim(f);
      assert.ok(current);
      await f.changeConfiguration("source");
      assert.equal(await f.repository.heartbeat(current, 30000), undefined);
      assert.equal(await f.repository.publish(current, f.result), false);
    },
  );
}
