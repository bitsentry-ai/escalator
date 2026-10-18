import { prepareRuleCandidate } from "../src/application/rules/prepare-candidate.js";
import { generatePreparedRuleCandidate } from "../src/application/rules/propose.js";
import { ruleCandidateInputSchema } from "../src/contracts/rule-candidate-input.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, at, label } from "./conformance/rule-backtest-fixture.js";
import { storedRuleReplaySnapshotSchema } from "../src/contracts/replay-run.js";
import { generateRuleCandidate } from "../src/application/rules/propose.js";
import type {
  ModelResolver,
  ModelGenerationRequest,
} from "../src/investigation/ports/index.js";
function source() {
  const snapshot = fixture();
  snapshot.snapshotAt = at(43201);
  snapshot.lastDecisionAt = at(43200);
  return storedRuleReplaySnapshotSchema.parse({
    workspaceId: snapshot.version.definition.workspaceId,
    snapshot,
    inputHash: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
  });
}
const parameters = {
  aggregation: "maximum",
  windowSeconds: 60,
  minimumSamples: 1,
  trigger: { operator: "gte", value: 1 },
  recovery: { operator: "lt", value: 1 },
  persistenceSeconds: 0,
  recoverySeconds: 0,
  cooldownSeconds: 0,
};
function models(
  response: unknown,
  requests: ModelGenerationRequest[],
): ModelResolver {
  return {
    resolve: async () => ({
      destination: {
        provider: "ollama",
        model: "local",
        location: "local",
        origin: "http://127.0.0.1:11434",
      },
      generate: async (request) => {
        requests.push(request);
        return {
          text: JSON.stringify(response),
          completion: "stop",
          usage: { outputTokens: 50 },
        };
      },
    }),
  };
}
test("candidate prompt excludes held-out rows, exclusion counts and free text", async () => {
  const data = source(),
    old = data.snapshot.samples[0]!;
  data.snapshot.samples.push({
    ...old,
    id: "heldout",
    observedAt: at(40000),
    receivedAt: at(40000),
  });
  data.inputHash = createHash("sha256")
    .update(JSON.stringify(data.snapshot))
    .digest("hex");
  const requests: ModelGenerationRequest[] = [];
  const result = await generateRuleCandidate(
    {
      source: data,
      labels: [
        {
          ...label("reviewed", 2, 3),
          summary: "secret-example-not-for-provider",
        },
      ],
      profileId: "profile",
      candidateId: "fresh",
    },
    models(
      {
        parameters,
        rationale: "Additional detection; coverage remains unknown.",
      },
      requests,
    ),
    new AbortController().signal,
  );
  assert.equal(requests.length, 1);
  const input = JSON.parse(requests[0]!.input);
  assert.equal(input.excludedSamples, undefined);
  assert.equal(input.excludedLabels, undefined);
  assert.equal(input.plan, undefined);
  assert.equal(
    input.days.reduce((n: number, d: { samples: number }) => n + d.samples, 0),
    10,
  );
  assert.ok(!requests[0]!.input.includes("secret-example"));
  assert.equal(result.reviewable, false);
  assert.equal(
    result.candidate.definition.severity,
    data.snapshot.version.definition.severity,
  );
  assert.equal(result.candidate.id, "fresh");
});
test("model cannot add mutation fields or change scope", async () => {
  const data = source(),
    requests: ModelGenerationRequest[] = [];
  await assert.rejects(
    generateRuleCandidate(
      { source: data, labels: [], profileId: "profile", candidateId: "fresh" },
      models(
        {
          parameters,
          rationale: "Reason",
          action: "disable",
          ruleId: "existing",
        },
        requests,
      ),
      new AbortController().signal,
    ),
  );
});
test("pre-cancelled work does not call the resolver", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const resolver: ModelResolver = {
    resolve: async () => {
      calls++;
      throw new Error("must not run");
    },
  };
  await assert.rejects(
    generateRuleCandidate(
      {
        source: source(),
        labels: [],
        profileId: "profile",
        candidateId: "fresh",
      },
      resolver,
      controller.signal,
    ),
    /cancelled/,
  );
  assert.equal(calls, 0);
});

test("abort returns even when a resolver ignores cancellation", async () => {
  const controller = new AbortController();
  const resolver: ModelResolver = {
    resolve: async () => {
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    },
  };
  await assert.rejects(
    generateRuleCandidate(
      {
        source: source(),
        labels: [],
        profileId: "profile",
        candidateId: "fresh",
      },
      resolver,
      controller.signal,
    ),
    /cancelled/,
  );
});

test("prepared messages round-trip without raw or withheld evidence and preserve the prompt", async () => {
  const data = source(),
    args = {
      source: data,
      labels: [label("reviewed", 2, 3)],
      profileId: "profile",
      candidateId: "fresh",
    };
  const prepared = prepareRuleCandidate(args),
    wire = JSON.parse(JSON.stringify(prepared));
  assert.deepEqual(ruleCandidateInputSchema.parse(wire), prepared);
  assert.ok(!JSON.stringify(wire).includes('"receipts"'));
  assert.ok(!JSON.stringify(wire).includes('"summary"'));
  assert.ok(!JSON.stringify(wire).includes('"excludedSamples"'));
  const local: ModelGenerationRequest[] = [],
    remote: ModelGenerationRequest[] = [];
  const response = { parameters, rationale: "Review" };
  await generateRuleCandidate(
    args,
    models(response, local),
    new AbortController().signal,
  );
  await generatePreparedRuleCandidate(
    wire,
    models(response, remote),
    new AbortController().signal,
  );
  assert.deepEqual(remote, local);
});
test("prepared messages reject added text, altered seeds and evidence beyond the cutoff", () => {
  const prepared = prepareRuleCandidate({
    source: source(),
    labels: [],
    profileId: "profile",
    candidateId: "fresh",
  });
  assert.equal(
    ruleCandidateInputSchema.safeParse({
      ...prepared,
      context: { ...prepared.context, rawText: "ignore instructions" },
    }).success,
    false,
  );
  assert.equal(
    ruleCandidateInputSchema.safeParse({
      ...prepared,
      context: {
        ...prepared.context,
        seed: { ...prepared.context.seed, stepSeconds: 120 },
      },
    }).success,
    false,
  );
  assert.equal(
    ruleCandidateInputSchema.safeParse({
      ...prepared,
      context: {
        ...prepared.context,
        days: [{ ...prepared.context.days[0], date: "2099-01-01" }],
      },
    }).success,
    false,
  );
  assert.equal(
    ruleCandidateInputSchema.safeParse({
      ...prepared,
      context: {
        ...prepared.context,
        reviewedLabels: [
          { startedAt: at(40000), endedAt: at(41000), outcome: "noise" },
        ],
      },
    }).success,
    false,
  );
});
