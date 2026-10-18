import test from "node:test";
import assert from "node:assert/strict";
import {
  captureInvestigation,
  sameInvestigationClaim,
  sameInvestigationConfiguration,
} from "../src/investigation/orchestration/capture.js";
import { investigationFixture } from "./fixtures/investigation.js";
function fixture() {
  const { claim } = investigationFixture();
  const intent = {
    id: claim.id,
    scope: claim.scope,
    idempotencyKey: "first-page",
    profileId: claim.profileId,
    limits: claim.limits,
    sources: claim.sources,
  };
  const configuration = {
    profile: {
      id: claim.profileId,
      revision: 1,
      scope: {
        workspaceId: claim.scope.workspaceId,
        serviceId: claim.scope.serviceId,
        environmentId: claim.scope.environmentId,
      },
      destination: {
        provider: "ollama",
        model: "local",
        location: "local",
        origin: "http://127.0.0.1:11434",
      },
      endpoint: "http://127.0.0.1:11434",
      secretId: null,
    },
    secretIds: [],
    sourceVersions: [{ kind: "log", sourceId: "source_a", revision: "1" }],
  };
  return { claim, intent, configuration };
}
test("capture detaches the configured profile and binding versions at enqueue", () => {
  const { intent, configuration } = fixture();
  const captured = captureInvestigation(intent, configuration);
  configuration.profile.revision = 2;
  intent.limits.maxModelCalls = 2;
  assert.equal(captured.configuration.profile.revision, 1);
  assert.equal(captured.intent.limits.maxModelCalls, 1);
});
test("profiles must match the incident service/environment and profile identity", () => {
  for (const property of [
    "workspaceId",
    "serviceId",
    "environmentId",
  ] as const) {
    const { intent, configuration } = fixture();
    const changed = {
      ...configuration,
      profile: {
        ...configuration.profile,
        scope: { ...configuration.profile.scope, [property]: "other" },
      },
    };
    assert.throws(() => captureInvestigation(intent, changed));
  }
  const { intent, configuration } = fixture();
  configuration.profile.id = "other";
  assert.throws(() => captureInvestigation(intent, configuration));
});
test("every selected source needs exactly one captured binding version", () => {
  const { intent, configuration } = fixture();
  assert.throws(() =>
    captureInvestigation(intent, { ...configuration, sourceVersions: [] }),
  );
  assert.throws(() =>
    captureInvestigation(intent, {
      ...configuration,
      sourceVersions: [
        ...configuration.sourceVersions,
        ...configuration.sourceVersions,
      ],
    }),
  );
  assert.throws(() =>
    captureInvestigation(intent, {
      ...configuration,
      sourceVersions: [{ kind: "log", sourceId: "other", revision: "1" }],
    }),
  );
});
test("configuration changes since enqueue revoke use even before the first model call", () => {
  const { intent, configuration } = fixture();
  const captured = captureInvestigation(intent, configuration).configuration;
  assert.equal(sameInvestigationConfiguration(captured, configuration), true);
  configuration.profile.revision = 2;
  assert.equal(sameInvestigationConfiguration(captured, configuration), false);
  configuration.profile.revision = 1;
  configuration.sourceVersions[0].revision = "2";
  assert.equal(sameInvestigationConfiguration(captured, configuration), false);
  assert.equal(sameInvestigationConfiguration(captured, null), false);
});
test("claim identity checks ignore caller expiry metadata but reject changed captured authority", () => {
  const { claim } = fixture();
  assert.equal(
    sameInvestigationClaim(
      { ...claim, leaseExpiresAt: "2099-01-01T00:00:00.000Z" },
      claim,
    ),
    true,
  );
  for (const field of ["runtimeId", "claimToken", "profileId", "id"] as const)
    assert.equal(
      sameInvestigationClaim({ ...claim, [field]: "other" }, claim),
      false,
    );
  assert.equal(
    sameInvestigationClaim(
      { ...claim, limits: { ...claim.limits, maxModelCalls: 2 } },
      claim,
    ),
    false,
  );
  assert.equal(sameInvestigationClaim({ ...claim, attempt: 2 }, claim), false);
});
test("captured secret approvals are unique and include the model binding", () => {
  const { intent, configuration } = fixture();
  assert.throws(() =>
    captureInvestigation(intent, {
      ...configuration,
      secretIds: ["key", "key"],
    }),
  );
  const profile = { ...configuration.profile, secretId: "key" };
  assert.throws(() =>
    captureInvestigation(intent, { ...configuration, profile }),
  );
  assert.deepEqual(
    captureInvestigation(intent, {
      ...configuration,
      profile,
      secretIds: ["key"],
    }).configuration.secretIds,
    ["key"],
  );
});

test("secret approval ordering is irrelevant but membership changes revoke configuration", () => {
  const { intent, configuration } = fixture();
  const captured = captureInvestigation(intent, {
    ...configuration,
    secretIds: ["key_a", "key_b"],
  }).configuration;
  assert.equal(
    sameInvestigationConfiguration(captured, {
      ...captured,
      secretIds: ["key_b", "key_a"],
    }),
    true,
  );
  for (const secretIds of [["key_a"], ["key_a", "key_b", "key_c"]])
    assert.equal(
      sameInvestigationConfiguration(captured, { ...captured, secretIds }),
      false,
    );
});
