import { randomUUID } from "node:crypto";
import {
  signalSourceSchema,
  probeSchema,
  metricMonitorSchema,
  workspaceIdSchema,
  workspaceSchema,
  serviceSchema,
  environmentSchema,
  responderSchema,
  incidentLabelInputSchema,
} from "@bitsentry-escalator/features/contracts";
import type {
  LabelStream,
  SignalRepository,
  ProbeRepository,
  MetricsRepository,
  SignalTransaction,
} from "@bitsentry-escalator/features/application";
function sourceKind(kind: string): "metrics" | "probe" | "generic" {
  if (kind === "metric") return "metrics";
  if (kind === "probe") return "probe";
  return "generic";
}

/** Real configured streams, reused by both database conformance fixtures. */
export async function seedRuleLabelStream(
  repositories: {
    signals: SignalRepository;
    probes: ProbeRepository;
    metrics: MetricsRepository;
  },
  stream: LabelStream,
): Promise<void> {
  const sourceId = stream.kind === "signal" ? stream.id : randomUUID();
  const source = (tx: SignalTransaction) =>
    signalSourceSchema.parse({
      id: sourceId,
      workspaceId: stream.workspaceId,
      serviceId: stream.serviceId,
      environmentId: stream.environmentId,
      name: "Label evidence",
      kind: sourceKind(stream.kind),
      enabled: true,
      version: 1,
      grouping: "source-fingerprint",
      recovery: "explicit",
      recoveryHoldSeconds: 60,
      authSecretId: null,
      createdAt: tx.now,
      updatedAt: tx.now,
    });
  if (stream.kind === "signal") {
    await repositories.signals.transaction(stream.workspaceId, (tx) =>
      tx.sources.insert(source(tx)),
    );
    return;
  }
  if (stream.kind === "probe") {
    await repositories.probes.transaction(stream.workspaceId, async (tx) => {
      await tx.sources.insert(source(tx));
      const accepted = await tx.probes.put(
        probeSchema.parse({
          id: stream.id,
          workspaceId: stream.workspaceId,
          sourceId,
          serviceId: stream.serviceId,
          environmentId: stream.environmentId,
          name: "Label probe",
          version: 1,
          enabled: true,
          intervalSeconds: 60,
          critical: false,
          failureThreshold: 2,
          recoveryThreshold: 2,
          config: {
            url: "https://example.test/health",
            method: "GET",
            body: null,
            authSecretId: null,
            timeoutMs: 1000,
            maxResponseBytes: 1000,
            assertions: { status: [200], contains: null, json: [] },
            syntheticWrite: null,
          },
          createdAt: tx.now,
          updatedAt: tx.now,
        }),
        null,
      );
      if (!accepted) throw new Error("Probe fixture already exists");
    });
    return;
  }
  await repositories.metrics.transaction(stream.workspaceId, async (tx) => {
    await tx.sources.insert(source(tx));
    const accepted = await tx.metrics.put(
      metricMonitorSchema.parse({
        id: stream.id,
        workspaceId: stream.workspaceId,
        sourceId,
        serviceId: stream.serviceId,
        environmentId: stream.environmentId,
        name: "Label metric",
        version: 1,
        enabled: true,
        stepSeconds: 60,
        query: {
          connection: {
            provider: "prometheus",
            baseUrl: "https://metrics.example",
            authSecretId: null,
          },
          requestsQuery: "sum(increase(requests_total[60s]))",
          errorsQuery: "sum(increase(errors_total[60s]))",
        },
        rule: {
          windowSeconds: 120,
          minimumSamples: 2,
          minimumRequests: 100,
          errorRateFloor: 0.05,
        },
        createdAt: tx.now,
        updatedAt: tx.now,
      }),
      null,
    );
    if (!accepted) throw new Error("Metric fixture already exists");
  });
}

export async function seedReviewedRuleLabel(
  fixture: Pick<
    import("../conformance/rule-labels.js").RuleLabelFixture,
    "foundation" | "repository" | "seedStream"
  >,
) {
  const scope = workspaceIdSchema.parse(randomUUID());
  const dates = {
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  };
  const service = serviceSchema.parse({
    id: randomUUID(),
    workspaceId: scope,
    name: "API",
    key: "api",
    owningTeam: "Platform",
    enabled: true,
    ...dates,
  });
  const environment = environmentSchema.parse({
    id: randomUUID(),
    workspaceId: scope,
    name: "Production",
    key: "production",
    isProduction: true,
    ...dates,
  });
  const responder = responderSchema.parse({
    id: randomUUID(),
    workspaceId: scope,
    hostUserId: randomUUID(),
    displayName: "Reviewer",
    role: "responder",
    timeZone: "UTC",
    enabled: true,
    ...dates,
  });
  await fixture.foundation.transaction(scope, async (tx) => {
    await tx.workspace.insert(
      workspaceSchema.parse({
        id: scope,
        name: "Label trigger test",
        ...dates,
      }),
    );
    await tx.services.insert(service);
    await tx.environments.insert(environment);
    await tx.responders.insert(responder);
  });
  const stream = { kind: "probe" as const, id: randomUUID() };
  await fixture.seedStream({
    ...stream,
    workspaceId: scope,
    serviceId: service.id,
    environmentId: environment.id,
  });
  const actor = {
    workspaceId: scope,
    responderId: responder.id,
    role: responder.role,
  };
  const input = incidentLabelInputSchema.parse({
    serviceId: service.id,
    environmentId: environment.id,
    stream,
    origin: "missed_incident",
    incidentId: null,
    outcome: "actionable",
    startedAt: dates.createdAt,
    endedAt: "2026-10-05T00:10:00.000Z",
    summary: "Reviewed impact",
  });
  const label = await fixture.repository.transaction(scope, async (tx) => {
    const draft = await tx.labels.create(actor, input);
    return tx.labels.review(actor, draft.id, 1);
  });
  return { label, actor };
}
