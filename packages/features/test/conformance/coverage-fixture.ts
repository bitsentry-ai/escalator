import {
  configuredPolicySchema,
  scheduleSchema,
  responderSchema,
  availabilitySchema,
  configuredContactSchema,
  deploymentCoverageBindingSchema,
  defaultEscalationSteps,
} from "../../src/contracts/index.js";
import type { DeploymentCoverageSnapshot } from "../../src/domain/deploy/coverage.js";
export function coverageFixture() {
  const binding = deploymentCoverageBindingSchema.parse({
    workspaceId: "one",
    targetId: "target",
    targetRevision: 1,
    policyId: "policy",
    serviceId: "api",
    environmentId: "prod",
    source: "ci",
    externalId: "42",
    mappedDeployerId: "alice",
  });
  const schedules = [
    ["primary", "alice"],
    ["peer", "bob"],
  ].map(([id, responder]) =>
    scheduleSchema.parse({
      id,
      workspaceId: "one",
      serviceId: "api",
      name: id,
      version: 1,
      enabled: true,
      rotations: [
        {
          id: "rotation",
          timeZone: "UTC",
          anchorLocal: "2026-01-01T00:00",
          shiftDays: 1,
          responders: [responder],
        },
      ],
      overrides: [],
    }),
  );
  const responders = ["alice", "bob"].map((id) =>
    responderSchema.parse({
      id,
      workspaceId: "one",
      hostUserId: id,
      displayName: id,
      timeZone: "UTC",
      role: "responder",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  const availability = responders.map((row) =>
    availabilitySchema.parse({
      id: row.id,
      workspaceId: "one",
      version: 1,
      timeZone: "UTC",
      windows: [
        { weekdays: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 },
      ],
    }),
  );
  const contacts = responders.map((row) =>
    configuredContactSchema.parse({
      id: `contact-${row.id}`,
      workspaceId: "one",
      responderId: row.id,
      version: 1,
      channel: "webhook",
      secretId: `secret-${row.id}`,
      enabled: true,
      priority: 0,
    }),
  );
  const policy = configuredPolicySchema.parse({
    id: "policy",
    workspaceId: "one",
    serviceId: "api",
    version: 1,
    enabled: true,
    primaryScheduleId: "primary",
    peerScheduleId: "peer",
    fallbackResponderIds: ["bob"],
    steps: defaultEscalationSteps(),
    terminal: {
      reminderIntervalMs: 60000,
      maxReminders: 1,
      action: "notify_operator",
      notifyResponderIds: ["bob"],
    },
    primaryPreviewId: "preview-a",
    peerPreviewId: "preview-b",
  });
  const snapshot: DeploymentCoverageSnapshot = {
    complete: true,
    policy,
    schedules,
    responders,
    availability,
    contacts,
  };
  return { binding, snapshot };
}
