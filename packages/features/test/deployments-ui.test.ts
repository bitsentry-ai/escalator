import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WatchSummary,
  EvidenceWindow,
  StreamEvidence,
} from "../src/ui/deployments/WatchSummary.js";
import { CoverageProof } from "../src/ui/deployments/CoverageProof.js";
import { escalatorResources } from "../src/locales/index.js";
import {
  workspaceIdSchema,
  deploymentWatchRecordSchema,
  deploymentCoverageDecisionSchema,
  type DeploymentWatchView,
  type EvaluatedWatchStream,
  type WatchStreamEvaluation,
} from "../src/contracts/index.js";
import { MemoryDeploymentRepository } from "./conformance/memory-deployments.js";
import {
  seedDeploymentFixture,
  fixtureDeployment,
} from "./conformance/deployments.js";
import { finishDeployment } from "../src/domain/deploy/lifecycle.js";
import { startDeploymentWatch } from "../src/application/deploy/watch-record.js";
const t = (key: string) => {
  let node: unknown = escalatorResources["en-US"].escalator;
  for (const part of key.split("."))
    node = (node as Record<string, unknown>)?.[part];
  assert.equal(typeof node, "string", `Missing ${key}`);
  return node as string;
};
async function fixture(): Promise<DeploymentWatchView> {
  const scope = workspaceIdSchema.parse("watch-ui");
  const repository = new MemoryDeploymentRepository();
  await seedDeploymentFixture(
    {
      repository,
      configuration: repository.configuration,
      work: repository.work,
      dispose: async () => {},
    },
    scope,
  );
  const entry = await repository.transaction(scope, (tx) =>
    fixtureDeployment(tx),
  );
  const at = new Date(
    Date.parse(entry.deployment.startedAt) + 300000,
  ).toISOString();
  const result = finishDeployment(
    entry.deployment,
    {
      version: 1,
      source: entry.deployment.source,
      externalId: entry.deployment.externalId,
      environmentId: entry.deployment.environmentId,
      actor: "ci",
      occurredAt: at,
      outcome: "SUCCEEDED",
    },
    at,
  );
  assert.equal(result.state, "changed");
  if (result.state !== "changed") throw new Error("finish");
  entry.deployment = result.deployment;
  return {
    targetId: entry.targetId,
    deployment: entry.deployment,
    watch: startDeploymentWatch(entry),
    baselineAvailable: true,
  };
}
test("successful release with no watch never renders a passing health verdict", async () => {
  const value = await fixture();
  value.watch = null;
  value.baselineAvailable = false;
  const html = renderToStaticMarkup(createElement(WatchSummary, { value, t }));
  assert.ok(html.includes(t("deployments.status.SUCCEEDED")));
  assert.ok(html.includes(t("deployments.noWatch")));
  assert.ok(html.includes(t("deployments.noBaseline")));
  assert.ok(
    !html.includes(`<strong>${t("deployments.verdict.PASS")}</strong>`),
  );
});
test("unfinished, incomplete and overlapping watch evidence remains visibly uncertain", async () => {
  const value = await fixture();
  value.watch = deploymentWatchRecordSchema.parse({
    ...value.watch,
    verdict: "INSUFFICIENT_DATA",
    evaluatedAt: value.watch!.startedAt,
    inventoryComplete: false,
    overlapInventoryComplete: false,
    overlappingDeploymentIds: ["other-release"],
  });
  const html = renderToStaticMarkup(createElement(WatchSummary, { value, t }));
  for (const key of [
    "verdict.INSUFFICIENT_DATA",
    "incomplete",
    "notFinal",
    "overlapWarning",
    "incompleteOverlap",
  ])
    assert.ok(html.includes(t(`deployments.${key}`)), key);
  assert.ok(html.includes("other-release"));
});
test("evidence tables bound both reference and gap rows and preserve unknown counts", () => {
  const value: WatchStreamEvaluation["watch"] = {
    requests: null,
    errors: null,
    failedProbes: null,
    coverage: {
      coverageVersion: 1,
      expectedSlots: 50,
      availableSlots: 0,
      queryComplete: false,
      gaps: Array.from({ length: 80 }, (_, i) => ({
        startAt: `gap-${i}-start`,
        endAt: "end",
        reason: "missing" as const,
      })),
    },
    evidence: Array.from({ length: 80 }, (_, i) => ({
      id: `reference-${i}-id`,
      version: 1,
      slotAt: "slot",
      stepSeconds: 60,
    })),
  };
  const html = renderToStaticMarkup(
    createElement(EvidenceWindow, { title: "Evidence", value, t }),
  );
  assert.equal((html.match(/<li>/g) ?? []).length, 50);
  assert.ok(html.includes("reference-24-id"));
  assert.ok(!html.includes("reference-25-id"));
  assert.ok(html.includes("gap-24-start"));
  assert.ok(!html.includes("gap-25-start"));
  assert.ok(html.includes(t("deployments.unknown")));
  assert.ok(html.includes(t("deployments.incomplete")));
});
test("historical override audit preserves expiry and escapes user text", () => {
  const proof = deploymentCoverageDecisionSchema.parse({
    id: "proof",
    binding: {
      workspaceId: "team",
      targetId: "target",
      targetRevision: 1,
      serviceId: "api",
      environmentId: "prod",
      policyId: "policy",
      source: "ci",
      externalId: "release",
      mappedDeployerId: null,
    },
    evaluation: {
      decision: "block",
      reason: "unmapped_deployer",
      eligibleResponderIds: [],
      fingerprint: "a".repeat(64),
      policyVersion: 1,
      scheduleVersions: [],
    },
    evaluatedAt: "2026-10-05T00:00:00.000Z",
    expiresAt: "2026-10-05T00:02:00.000Z",
    override: {
      responderId: "admin",
      reason: "Emergency <script>alert(1)</script>",
    },
  });
  const html = renderToStaticMarkup(
    createElement(CoverageProof, { proof, linked: true, error: false, t }),
  );
  assert.ok(html.includes("2026-10-05T00:02:00.000Z"));
  assert.ok(html.includes(t("deployments.override")));
  assert.ok(html.includes("admin"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  const missing = renderToStaticMarkup(
    createElement(CoverageProof, { linked: true, error: true, t }),
  );
  assert.ok(missing.includes(t("deployments.proofUnavailable")));
  assert.ok(!missing.includes(t("deployments.trackingOnly")));
});

test("small but nonzero error thresholds are not displayed as zero", () => {
  const summary = {
    requests: 1000000,
    errors: 1,
    failedProbes: null,
    coverage: {
      coverageVersion: 1 as const,
      expectedSlots: 3,
      availableSlots: 3,
      queryComplete: true,
      gaps: [],
    },
    evidence: [],
  };
  const stream: EvaluatedWatchStream = {
    kind: "metric",
    id: "metric",
    sourceId: "source",
    evaluation: {
      evaluatorVersion: 1,
      streamId: "metric",
      criteria: {
        version: 1,
        kind: "metric",
        baselineMinimumSamples: 3,
        watchMinimumSamples: 3,
        minimumRequests: 100,
        errorRateFloor: 0.000002,
        relativeMultiplier: 2,
        absoluteIncrease: 0.000001,
      },
      evaluatedAt: "2026-10-05T00:00:00.000Z",
      final: false,
      verdict: "PENDING",
      reason: "observing",
      baseline: summary,
      watch: summary,
      baselineErrorRate: 0.000001,
      watchErrorRate: 0.000001,
      effectiveErrorRateThreshold: 0.000002,
      longestFailureRun: null,
    },
  };
  const html = renderToStaticMarkup(
    createElement(StreamEvidence, { stream, t }),
  );
  assert.ok(html.includes("0.0001%"));
  assert.ok(html.includes("0.0002%"));
  assert.ok(!html.includes("0.00%"));
});
