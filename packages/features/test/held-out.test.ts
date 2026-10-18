import { ruleEvaluationSealSchema } from "../src/contracts/rule-evaluation.js";
import { MemoryFoundationRepository } from "./conformance/memory.js";
import { workspaceSchema, responderSchema } from "../src/contracts/entities.js";
import { withRuleReplay } from "../src/application/rules/replay-transaction.js";
import { withRuleReplayCapture } from "../src/application/rules/replay-capture-transaction.js";
import type { RuleReplayCaptureRepository } from "../src/application/rules/replay-capture.js";
import type {
  RuleReplayRun,
  StoredRuleReplaySnapshot,
} from "../src/contracts/replay-run.js";
import type { Actor } from "../src/contracts/identity.js";
import { EvaluateHeldOutRule } from "../src/application/rules/held-out.js";
import test from "node:test";
import { workspaceIdSchema } from "../src/contracts/identity.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, at } from "./conformance/rule-backtest-fixture.js";
import { ruleReplaySnapshotSchema } from "../src/contracts/rule-replay.js";
import { storedRuleReplaySnapshotSchema } from "../src/contracts/replay-run.js";
import { deriveHeldOutReplay } from "../src/application/rules/held-out.js";
import { planRuleTuning } from "../src/application/rules/tuning.js";
import {
  encodeRuleReplayData,
  decodeRuleReplaySnapshot,
} from "../src/application/rules/replay-storage-codec.js";
const hash = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
function capture() {
  const old = fixture(),
    d = old.version.definition;
  const snapshot = ruleReplaySnapshotSchema.parse({
    ...old,
    snapshotAt: at(43201),
    lastDecisionAt: at(43200),
    complete: false,
    samples: [],
    coverage: [],
    policies: [],
    retained: {
      measurementHash: "a".repeat(64),
      policyFacts: [],
      policyComplete: false,
      history: {
        workspaceId: d.workspaceId,
        serviceId: d.serviceId,
        environmentId: d.environmentId,
        kind: d.selector.kind,
        streamId: d.selector.streamId,
        snapshotAt: at(43201),
        visibleAt: at(43201),
        startAt: at(0),
        endAt: at(43200),
        complete: false,
        configurations: [],
        receipts: [],
      },
    },
  });
  return storedRuleReplaySnapshotSchema.parse({
    workspaceId: d.workspaceId,
    snapshot,
    inputHash: hash(snapshot),
  });
}
test("held-out derivation fixes interval, seals candidate and preserves unknown coverage", () => {
  const source = capture(),
    candidate = { ...source.snapshot.version, id: "candidate" },
    result = deriveHeldOutReplay(source, candidate),
    plan = planRuleTuning(source.snapshot);
  assert.deepEqual(
    {
      firstDecisionAt: result.snapshot.firstDecisionAt,
      lastDecisionAt: result.snapshot.lastDecisionAt,
    },
    plan.heldOut,
  );
  assert.equal(result.snapshot.evaluation?.candidateHash, hash(candidate));
  assert.equal(result.snapshot.evaluation?.sourceInputHash, source.inputHash);
  assert.equal(result.snapshot.complete, false);
  assert.equal(result.snapshot.retained?.policyComplete, false);
  assert.equal(result.snapshot.retained?.baselines, undefined);
  assert.equal(result.inputHash, hash(result.snapshot));
  assert.equal(source.snapshot.evaluation, undefined);
  const restored = decodeRuleReplaySnapshot(
    source.workspaceId,
    JSON.parse(encodeRuleReplayData(source.workspaceId, "snapshot", result)),
  );
  assert.deepEqual(restored, result);
});
test("one source has one deterministic held-out slot, regardless of candidate edits", () => {
  const source = capture(),
    a = deriveHeldOutReplay(source, { ...source.snapshot.version, id: "a" }),
    b = deriveHeldOutReplay(source, { ...source.snapshot.version, id: "b" });
  assert.equal(a.snapshot.snapshotId, b.snapshot.snapshotId);
  assert.notEqual(a.inputHash, b.inputHash);
  assert.throws(
    () => deriveHeldOutReplay(a, a.snapshot.version),
    /original retained capture/,
  );
});
test("untrusted hash, foreign scope and changed cadence are rejected", () => {
  const s = capture(),
    candidate = structuredClone(s.snapshot.version);
  assert.throws(
    () => deriveHeldOutReplay({ ...s, inputHash: "0".repeat(64) }, candidate),
    /integrity/,
  );
  candidate.definition.workspaceId = workspaceIdSchema.parse("other");
  assert.throws(() => deriveHeldOutReplay(s, candidate), /scope_violation/);
  candidate.definition.workspaceId = workspaceIdSchema.parse("org");
  candidate.definition.stepSeconds = 120;
  candidate.definition.windowSeconds = 120;
  assert.throws(() => deriveHeldOutReplay(s, candidate), /cadence/);
});

async function setup() {
  const source = capture(),
    scope = source.workspaceId,
    foundation = new MemoryFoundationRepository({
      now: () => new Date(at(43202)),
    });
  const responder = responderSchema.parse({
    id: "operator",
    workspaceId: scope,
    hostUserId: "local",
    displayName: "Operator",
    timeZone: "UTC",
    role: "administrator",
    enabled: true,
    createdAt: at(0),
    updatedAt: at(0),
  });
  const actor: Actor = {
    workspaceId: scope,
    responderId: responder.id,
    role: responder.role,
  };
  await foundation.transaction(scope, async (tx) => {
    await tx.workspace.insert(
      workspaceSchema.parse({
        id: scope,
        name: "Rules",
        createdAt: at(0),
        updatedAt: at(0),
      }),
    );
    await tx.responders.insert(responder);
  });
  const control = { failEnqueue: false };
  type State = { runs: RuleReplayRun[]; snapshots: StoredRuleReplaySnapshot[] };
  const repository: RuleReplayCaptureRepository = {
    transaction: (tenant, work) =>
      foundation.withExtensions(tenant, async (base, extensions, guard) => {
        const data = (extensions.heldout ??= {
          runs: [],
          snapshots: [source],
        }) as State;
        const replay = withRuleReplay(
          {
            ...base,
            work: {
              ...base.work,
              enqueue: (...args: Parameters<typeof base.work.enqueue>) =>
                guard.operation(async () => {
                  if (control.failEnqueue) throw new Error("enqueue failure");
                  return base.work.enqueue(...args);
                }),
            },
          },
          {
            currentTime: async () => at(43202),
            lock: async (id) =>
              structuredClone(
                data.runs.find((r) => r.id === id && r.workspaceId === tenant),
              ),
            snapshot: async (id) =>
              structuredClone(
                data.snapshots.find(
                  (r) =>
                    r.snapshot.snapshotId === id && r.workspaceId === tenant,
                ),
              ),
            append: async () => {
              throw new Error("not execution");
            },
            save: async () => {
              throw new Error("not execution");
            },
          },
          guard,
        );
        return work(
          withRuleReplayCapture(
            replay,
            {
              reserve: async () => {},
              evidence: async () => {
                throw new Error("must not recapture");
              },
              insert: async (snapshot, run) => {
                if (
                  data.snapshots.some(
                    (s) =>
                      s.snapshot.snapshotId === snapshot.snapshot.snapshotId,
                  ) ||
                  data.runs.some((r) => r.id === run.id)
                )
                  throw new Error("duplicate");
                data.snapshots.push(structuredClone(snapshot));
                data.runs.push(structuredClone(run));
              },
            },
            guard,
          ),
        );
      }),
  };
  return {
    source,
    actor,
    foundation,
    control,
    useCase: new EvaluateHeldOutRule(repository),
    state: () =>
      foundation.withExtensions(scope, async (_base, ext) =>
        structuredClone(ext.heldout as State | undefined),
      ),
  };
}
test("evaluation retries reuse one sealed run and candidate edits cannot replace it", async () => {
  const x = await setup(),
    candidate = { ...x.source.snapshot.version, id: "candidate" };
  const first = await x.useCase.create(
    x.actor,
    x.source.snapshot.snapshotId,
    candidate,
  );
  assert.deepEqual(
    await x.useCase.create(x.actor, x.source.snapshot.snapshotId, candidate),
    first,
  );
  await assert.rejects(
    x.useCase.create(x.actor, x.source.snapshot.snapshotId, {
      ...candidate,
      id: "changed",
    }),
    /already sealed/,
  );
  assert.equal((await x.state())?.runs.length, 1);
});
test("enqueue failure rolls back snapshot and run; viewer cannot request evaluation", async () => {
  const x = await setup(),
    candidate = { ...x.source.snapshot.version, id: "candidate" };
  x.control.failEnqueue = true;
  await assert.rejects(
    x.useCase.create(x.actor, x.source.snapshot.snapshotId, candidate),
    /enqueue failure/,
  );
  assert.equal((await x.state())?.runs.length ?? 0, 0);
  x.control.failEnqueue = false;
  await assert.rejects(
    x.useCase.create(
      { ...x.actor, role: "viewer" },
      x.source.snapshot.snapshotId,
      candidate,
    ),
    /forbidden/,
  );
  const run = await x.useCase.create(
    x.actor,
    x.source.snapshot.snapshotId,
    candidate,
  );
  assert.equal(run.status, "queued");
});

test("stored evaluation seals reject a shortened gap and submillisecond cutoffs", () => {
  const source = capture(),
    sealed = deriveHeldOutReplay(source, {
      ...source.snapshot.version,
      id: "candidate",
    }).snapshot.evaluation!;
  assert.equal(
    ruleEvaluationSealSchema.safeParse({
      ...sealed,
      trainingCutoffAt: sealed.firstDecisionAt,
    }).success,
    false,
  );
  assert.equal(
    ruleEvaluationSealSchema.safeParse({
      ...sealed,
      trainingCutoffAt: sealed.trainingCutoffAt.replace(".000Z", ".000001Z"),
    }).success,
    false,
  );
});
