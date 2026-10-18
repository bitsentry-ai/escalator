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
