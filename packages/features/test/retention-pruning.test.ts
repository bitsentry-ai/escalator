import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema, workspaceSchema } from "../src/contracts/index.js";
import {
  pruneReplayInTransaction,
  type ReplayPruneSnapshot,
  type ReplayPruneCursor,
} from "../src/application/retention/pruning.js";
import { replayPruneTransaction } from "../src/application/retention/pruning-transaction.js";
import { MemoryFoundationRepository } from "./conformance/memory.js";
const scope = workspaceIdSchema.parse("team"),
  now = "2026-10-03T00:00:00.000Z",
  MiB = 1024 ** 2;
const row = (id: string, protectedRow = false) => ({
  workspaceId: scope,
  sourceId: "source",
  kind: "signal" as const,
  id,
  observedAt: "2026-08-01T00:00:00.000Z",
  bytes: MiB,
  protected: protectedRow,
});
const snapshot = (
  rows: ReplayPruneSnapshot["candidates"] = [row("a"), row("b", true)],
): ReplayPruneSnapshot => ({
  databaseNow: now,
  retainedBytes: rows.reduce((sum, value) => sum + value.bytes, 0),
  policy: null,
  candidates: rows,
  hasMore: false,
});
async function fixture(initial = snapshot()) {
  const foundation = new MemoryFoundationRepository({
    now: () => new Date(now),
  });
  await foundation.withExtensions(scope, async (tx, extra) => {
    await tx.workspace.insert(
      workspaceSchema.parse({
        id: scope,
        name: "Team",
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
    );
    extra.prune = structuredClone(initial);
  });
  const run = <T>(
    work: (tx: ReturnType<typeof replayPruneTransaction>) => Promise<T>,
    mismatch = false,
  ) =>
    foundation.withExtensions(scope, async (base, extra, guard) => {
      const data = extra.prune as ReplayPruneSnapshot;
      return work(
        replayPruneTransaction(
          base,
          {
            snapshot: async () => structuredClone(data),
            remove: async (selected) => {
              const keys = new Set(
                selected.map((value) => `${value.kind}:${value.id}`),
              );
              const deleted = data.candidates.filter((value) =>
                keys.has(`${value.kind}:${value.id}`),
              );
              const bytes = deleted.reduce(
                (sum, value) => sum + value.bytes,
                0,
              );
              data.candidates = data.candidates.filter(
                (value) => !keys.has(`${value.kind}:${value.id}`),
              );
              data.retainedBytes -= bytes;
              return {
                deletedRows: deleted.length,
                deletedBytes: bytes,
                retainedBytes: data.retainedBytes + (mismatch ? 1 : 0),
              };
            },
          },
          guard,
        ),
      );
    });
  const read = () =>
    foundation.withExtensions(scope, async (_, extra) =>
      structuredClone(extra.prune as ReplayPruneSnapshot),
    );
  return { foundation, run, read };
}
test("pruning reports committed counts, protects current references and audits the batch", async () => {
  const f = await fixture();
  const result = await f.run((tx) =>
    pruneReplayInTransaction(tx, "source", null, "audit"),
  );
  assert.equal(result.deletedRows, 1);
  assert.equal(result.retainedBytes, MiB);
  assert.equal(result.complete, true);
  assert.deepEqual(
    (await f.read()).candidates.map((value) => value.id),
    ["b"],
  );
  await f.foundation.transaction(scope, async (tx) => {
    const events = (await tx.audit.list({ limit: 10 })).items;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.metadata.deletedRows, 1);
  });
});
test("an accounting discrepancy rolls back deletion and audit", async () => {
  const f = await fixture();
  await assert.rejects(
    f.run((tx) => pruneReplayInTransaction(tx, "source", null, "audit"), true),
    /mismatch/,
  );
  assert.equal((await f.read()).candidates.length, 2);
  await f.foundation.transaction(scope, async (tx) =>
    assert.equal((await tx.audit.list({ limit: 10 })).items.length, 0),
  );
});
test("an audit failure rolls back payload deletion", async () => {
  const f = await fixture(snapshot([row("a")]));
  await f.foundation.transaction(scope, (tx) =>
    tx.audit.append({
      id: "audit",
      workspaceId: scope,
      actor: { kind: "system", component: "test" },
      action: "fixture",
      subjectType: "workspace",
      subjectId: scope,
      recordedAt: tx.now,
      metadata: {},
    }),
  );
  await assert.rejects(
    f.run((tx) => pruneReplayInTransaction(tx, "source", null, "audit")),
    /already_exists/,
  );
  assert.equal((await f.read()).retainedBytes, MiB);
});
test("the deletion cap does not skip eligible records after the hundredth deletion", async () => {
  const rows = Array.from({ length: 103 }, (_, i) =>
    row(String(i).padStart(4, "0")),
  );
  const f = await fixture(snapshot(rows));
  const result = await f.run((tx) =>
    pruneReplayInTransaction(tx, "source", null, "audit"),
  );
  assert.equal(result.deletedRows, 100);
  assert.equal(result.complete, false);
  assert.equal(result.next?.id, "0099");
  assert.equal((await f.read()).candidates.length, 3);
});
test("a full protected page advances without an audit or fabricated reclamation", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) =>
    row(String(i).padStart(4, "0"), true),
  );
  const f = await fixture({ ...snapshot(rows), hasMore: true });
  const result = await f.run((tx) =>
    pruneReplayInTransaction(tx, "source", null, "audit"),
  );
  assert.equal(result.deletedRows, 0);
  assert.equal(result.next?.id, "0999");
  assert.equal(result.complete, false);
  await f.foundation.transaction(scope, async (tx) =>
    assert.equal((await tx.audit.list({ limit: 10 })).items.length, 0),
  );
});
test("foreign candidates and a non-progressing cursor fail before deletion", async () => {
  const f = await fixture(
    snapshot([{ ...row("a"), workspaceId: workspaceIdSchema.parse("other") }]),
  );
  await assert.rejects(
    f.run((tx) => pruneReplayInTransaction(tx, "source", null, "audit")),
    /scope/,
  );
  const valid = await fixture(snapshot([row("a")]));
  const cursor: ReplayPruneCursor = {
    id: "a",
    kind: "signal",
    observedAt: row("a").observedAt,
  };
  await assert.rejects(
    valid.run((tx) => pruneReplayInTransaction(tx, "source", cursor, "audit")),
    /Unordered/,
  );
  assert.equal((await valid.read()).candidates.length, 1);
});
test("caught protected-deletion errors poison the transaction and handles expire", async () => {
  const f = await fixture();
  let saved: ReturnType<typeof replayPruneTransaction> | undefined;
  await assert.rejects(
    f.run(async (tx) => {
      saved = tx;
      await tx.retentionPrune.snapshot(null);
      await assert.rejects(
        tx.retentionPrune.remove([{ kind: "signal", id: "b" }]),
        /eligible/,
      );
    }),
    /eligible/,
  );
  await assert.rejects(
    saved!.retentionPrune.snapshot(null),
    /closed_transaction/,
  );
  assert.equal((await f.read()).candidates.length, 2);
});

test("an ordered page reaching recent history ends an age-only sweep without scanning the rest", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    ...row(String(i).padStart(4, "0")),
    observedAt: now,
  }));
  const f = await fixture({ ...snapshot(rows), hasMore: true });
  const result = await f.run((tx) =>
    pruneReplayInTransaction(tx, "source", null, "audit"),
  );
  assert.equal(result.deletedRows, 0);
  assert.equal(result.complete, true);
  assert.equal(result.next, null);
});
test("equal timestamps and IDs remain separate across receipt kinds", async () => {
  const f = await fixture(
    snapshot([
      { ...row("a"), kind: "metric" },
      { ...row("a"), kind: "probe" },
      row("a"),
    ]),
  );
  const result = await f.run((tx) =>
    pruneReplayInTransaction(tx, "source", null, "audit"),
  );
  assert.equal(result.deletedRows, 3);
  assert.equal(result.retainedBytes, 0);
});

test("cursor ordering preserves sub-millisecond instants before comparing IDs", async () => {
  const f = await fixture(
    snapshot([{ ...row("a"), observedAt: "2026-08-01T00:00:00.000002Z" }]),
  );
  const after: ReplayPruneCursor = {
    kind: "signal",
    id: "z",
    observedAt: "2026-08-01T00:00:00.000001Z",
  };
  const result = await f.run((tx) =>
    pruneReplayInTransaction(tx, "source", after, "audit"),
  );
  assert.equal(result.deletedRows, 1);
  assert.equal(result.complete, true);
});
test("a capped selection cannot advance past an undeleted earlier cursor record", async () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({
    ...row(String(1000 - i).padStart(4, "0")),
    observedAt: `2026-08-01T00:00:00.${String(i + 1).padStart(6, "0")}Z`,
  }));
  const f = await fixture(snapshot(rows));
  const first = await f.run((tx) =>
    pruneReplayInTransaction(tx, "source", null, "audit-one"),
  );
  assert.equal(first.deletedRows, 100);
  assert.equal(first.complete, false);
  assert.equal(first.next, null);
  const second = await f.run((tx) =>
    pruneReplayInTransaction(tx, "source", first.next, "audit-two"),
  );
  assert.equal(second.deletedRows, 1);
  assert.equal(second.complete, true);
  assert.equal((await f.read()).retainedBytes, 0);
});
