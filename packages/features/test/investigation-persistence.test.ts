import test from "node:test";
import { sameInvestigationClaim } from "../src/investigation/orchestration/capture.js";
import {
  investigationPersistenceConformance,
  type InvestigationPersistenceFixture,
} from "./conformance/investigations.js";
import { investigationFixture } from "./fixtures/investigation.js";
import {
  validateInvestigationResult,
  validateInvestigationTrace,
} from "../src/investigation/orchestration/claims.js";
import type {
  InvestigationClaim,
  InvestigationIntent,
  InvestigationRepository,
  InvestigationRunResult,
  InvestigationTraceEvent,
} from "../src/investigation/ports/index.js";
/** Test reference state machine only. It is not a production persistence fallback. */
async function memoryFixture(): Promise<InvestigationPersistenceFixture> {
  const sample = investigationFixture();
  const intent: InvestigationIntent = {
    id: sample.claim.id,
    scope: sample.claim.scope,
    idempotencyKey: "incident-start",
    profileId: sample.claim.profileId,
    limits: sample.claim.limits,
    sources: [...sample.claim.sources],
  };
  let queued: InvestigationIntent | undefined;
  let active: InvestigationClaim | undefined;
  let published: InvestigationRunResult | undefined;
  let configurationCurrent = true;
  let attempts = 0;
  let now = Date.parse(sample.result.report.startedAt);
  const revoked = new Set<string>();
  const traces = new Map<string, InvestigationTraceEvent>();
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const fence = (claim: InvestigationClaim) =>
    active !== undefined &&
    configurationCurrent &&
    !published &&
    !revoked.has(claim.runtimeId) &&
    sameInvestigationClaim(claim, active) &&
    Date.parse(active.leaseExpiresAt) > now;
  const reopen = (): InvestigationRepository => ({
    async claim(input) {
      if (
        !queued ||
        !configurationCurrent ||
        attempts >= 3 ||
        published ||
        input.workspaceId !== queued.scope.workspaceId ||
        revoked.has(input.runtimeId) ||
        (active && Date.parse(active.leaseExpiresAt) > now)
      )
        return undefined;
      active = {
        id: queued.id,
        scope: structuredClone(queued.scope),
        profileId: queued.profileId,
        limits: structuredClone(queued.limits),
        sources: structuredClone(queued.sources),
        runtimeId: input.runtimeId,
        claimToken: input.claimToken,
        leaseExpiresAt: new Date(now + input.leaseMs).toISOString(),
        attempt: ++attempts,
      };
      return structuredClone(active);
    },
    async heartbeat(claim, ms) {
      if (!fence(claim)) return undefined;
      active = { ...active!, leaseExpiresAt: new Date(now + ms).toISOString() };
      return { leaseExpiresAt: active!.leaseExpiresAt };
    },
    async publish(claim, result) {
      if (!fence(claim)) return false;
      try {
        const validated = validateInvestigationResult(active!, result);
        published = validated;
        return true;
      } catch {
        return false;
      }
    },
    async get(scope, id) {
      return published && id === intent.id && same(scope, intent.scope)
        ? structuredClone(published.report)
        : undefined;
    },
    async getEvidence(scope, id) {
      return published && id === intent.id && same(scope, intent.scope)
        ? structuredClone(published.evidence)
        : [];
    },
  });
  return {
    maxAttempts: 3,
    async changeConfiguration() {
      configurationCurrent = false;
    },
    intent,
    result: sample.result,
    otherScope: {
      ...intent.scope,
      workspaceId: "org_other" as typeof intent.scope.workspaceId,
    },
    writer: {
      async enqueue(input) {
        if (queued) return "duplicate";
        queued = structuredClone(input);
        return "inserted";
      },
    },
    repository: reopen(),
    reopen,
    trace: {
      async append(claim, input) {
        if (!fence(claim)) return false;
        try {
          const event = validateInvestigationTrace(active!, input);
          const key = `${active!.attempt}:${event.sequence}`;
          const prior = traces.get(key);
          if (prior) return same(prior, event);
          traces.set(key, event);
          return true;
        } catch {
          return false;
        }
      },
    },
    async expire(claim) {
      if (active?.claimToken === claim.claimToken)
        now = Date.parse(active.leaseExpiresAt);
    },
    async revokeRuntime(runtimeId) {
      revoked.add(runtimeId);
    },
    async traces() {
      return structuredClone(
        [...traces.entries()]
          .filter(([key]) => key.startsWith(`${active?.attempt}:`))
          .map(([, event]) => event),
      );
    },
    async committed(claim) {
      return active?.claimToken === claim.claimToken;
    },
    async dispose() {},
  };
}
investigationPersistenceConformance(
  "memory investigation persistence",
  memoryFixture,
  test,
);
