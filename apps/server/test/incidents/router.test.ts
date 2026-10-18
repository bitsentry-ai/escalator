import type {
  IncidentLabelManagement,
  InvestigationReports,
  InvestigationSettingsUseCases,
  InvestigationSourceCatalog,
} from "@bitsentry-escalator/features/application";
import type {
  DeploymentManagement,
  DeploymentPreflight,
  DeploymentQueries,
} from "@bitsentry-escalator/features/application";
import type { RetentionManagement } from "@bitsentry-escalator/features/application";
import type { MetricManagement } from "@bitsentry-escalator/features/application";
import type { HeartbeatManagement } from "@bitsentry-escalator/features/application";
import type {
  DetectionManagement,
  ProbeManagement,
} from "@bitsentry-escalator/features/application";
import type { SignalManagement } from "@bitsentry-escalator/features/application";
import type { PostgresSecretWriter } from "../../src/platform/secrets/postgres-secret.writer.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  workspaceIdSchema,
  manualIncidentInputSchema,
  type Actor,
} from "@bitsentry-escalator/features/contracts";
import type {
  ConfigurationUseCases,
  IncidentUseCases,
  ServiceUseCases,
} from "@bitsentry-escalator/features/application";
import type { LocalAuthService } from "../../src/platform/auth/auth.service.js";
import { incidentsRouter } from "../../src/features/incidents/incidents.router.js";
test("standalone incident routes require current identity, reject injected scope and map inactive policy", async () => {
  const req = {
    session: { account: { accountId: "owner", authVersion: 1 } },
  } as unknown as Request;
  const actors: Actor[] = [];
  let unavailable = false;
  const resolutions: Actor[] = [];
  const incidents = {
    resolve: async (actor: Actor) => {
      resolutions.push(actor);
      return { state: "resolved" };
    },
    create: async (actor: Actor) => {
      actors.push(actor);
      if (unavailable)
        throw Object.assign(new Error(), { code: "paging_unavailable" });
      return { incidentId: "manual", pageId: "page" };
    },
  } as unknown as IncidentUseCases;
  const caller = incidentsRouter.createCaller({
    req,
    res: {} as Response,
    services: {} as ServiceUseCases,
    incidents,
    signals: {} as SignalManagement,
    detection: {} as DetectionManagement,
    probes: {} as ProbeManagement,
    metrics: {} as MetricManagement,
    labels: {} as IncidentLabelManagement,
    investigationReports: {} as InvestigationReports,
    investigationSettings: {} as InvestigationSettingsUseCases,
    investigationSourceCatalog: {} as InvestigationSourceCatalog,
    retention: {} as RetentionManagement,
    heartbeats: {} as HeartbeatManagement,
    deployments: {} as DeploymentManagement,
    deploymentPreflight: {} as DeploymentPreflight,
    deploymentQueries: {} as DeploymentQueries,
    secretWriter: {} as PostgresSecretWriter,
    configuration: {} as ConfigurationUseCases,
    workspaceId: workspaceIdSchema.parse("local"),
    auth: {
      current: async () => ({ id: "owner", role: "responder" }),
    } as unknown as LocalAuthService,
  });
  const input = manualIncidentInputSchema.parse({
    requestId: "manual",
    serviceId: "api",
    environmentId: "prod",
    policyId: "policy",
    title: "Outage",
    severity: "critical",
  });
  await caller.create(input);
  assert.deepEqual(actors, [
    { workspaceId: "local", responderId: "owner", role: "responder" },
  ]);
  await assert.rejects(
    caller.create({ ...input, workspaceId: "foreign" } as never),
    { code: "BAD_REQUEST" },
  );
  assert.equal(actors.length, 1);
  unavailable = true;
  await assert.rejects(caller.create(input), { code: "PRECONDITION_FAILED" });
  await caller.resolve({ id: "manual" });
  assert.deepEqual(resolutions, [
    { workspaceId: "local", responderId: "owner", role: "responder" },
  ]);
  await assert.rejects(
    caller.resolve({ id: "manual", workspaceId: "foreign" } as never),
    { code: "BAD_REQUEST" },
  );
  delete req.session.account;
  await assert.rejects(caller.resolve({ id: "manual" }), {
    code: "UNAUTHORIZED",
  });
  await assert.rejects(caller.create(input), { code: "UNAUTHORIZED" });
  assert.equal(actors.length, 2);
});
