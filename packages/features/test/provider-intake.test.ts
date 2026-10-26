import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
  type ProviderIntake as IntakeConfiguration,
} from "../src/contracts/index.js";
import { SignalManagement } from "../src/application/signals/management.js";
import {
  ProviderIntake,
  type ProviderDelivery,
} from "../src/application/signals/provider-ingest.js";
import { ProviderHttp } from "../src/application/signals/provider-http.js";
import {
  assertSourceVerificationClaim,
  type SourceVerificationClaim,
  type SourceVerificationUse,
  type SourceVerificationSecrets,
} from "../src/application/signals/source-secrets.js";
import type { SignalRepository } from "../src/application/signals/ports.js";
import { MemorySignalRepository } from "./conformance/memory-signals.js";
import { seedSignalFixture } from "./conformance/signals.js";
import sample from "./intake/sentry-issue-alert.json";
function providerFor(
  mode: string,
): "sentry" | "glitchtip" | "grafana-signed" | "grafana" {
  if (mode === "sentry-hmac") return "sentry";
  if (mode === "glitchtip") return "glitchtip";
  if (mode === "grafana-hmac") return "grafana-signed";
  return "grafana";
}
const secret = Buffer.from("test-provider-key");
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const sign = (body: Uint8Array) =>
  createHmac("sha256", secret).update(body).digest("hex");
const grafana = (fingerprints = ["c6eadffa33fcdf37"]) =>
  bytes({
    version: "1",
    status: "firing",
    truncatedAlerts: 0,
    alerts: fingerprints.map((fingerprint) => ({
      status: "firing",
      fingerprint,
      startsAt: "2026-09-20T00:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      labels: {},
    })),
  });
async function fixture(intake: IntakeConfiguration = { mode: "sentry-hmac" }) {
  let now = new Date("2026-09-20T00:00:00.000Z");
  const repository = new MemorySignalRepository(() => now);
  const actor: Actor = {
    workspaceId: workspaceIdSchema.parse("workspace"),
    responderId: responderIdSchema.parse("owner"),
    role: "administrator",
  };
  await repository.transaction(actor.workspaceId, seedSignalFixture);
  let sequence = 0;
  const newId = () => `provider-${++sequence}`;
  const management = new SignalManagement(repository, newId);
  const signed = intake.mode.endsWith("hmac");
  const source = await management.createProvider(actor, {
    name: "Provider",
    serviceId: "service",
    environmentId: "production",
    intake,
    authSecretId: signed ? "fixture-secret" : null,
  });
  const grant = signed
    ? await management.issueReceiver(actor, { sourceId: source.id })
    : await management.issueToken(actor, { sourceId: source.id });
  const request: ProviderDelivery = {
    provider: providerFor(intake.mode),
    reference: "receiverId" in grant ? grant.receiverId : source.id,
    authorization: "token" in grant ? `Bearer ${grant.token}` : undefined,
    body: bytes(sample),
    signature: sign(bytes(sample)),
    signal: new AbortController().signal,
  };
  const secrets: SourceVerificationSecrets = {
    async withSecret(use, consume) {
      assert.equal(use.workspaceId, actor.workspaceId);
      assert.equal(use.sourceId, source.id);
      assert.equal(use.grantId, grant.id);
      assert.equal(use.secretId, "fixture-secret");
      const value = Buffer.from(secret);
      try {
        return consume(value);
      } finally {
        value.fill(0);
      }
    },
  };
  const runner = (
    overrides: {
      secrets?: SourceVerificationSecrets;
      repository?: SignalRepository;
      allowed?: boolean;
    } = {},
  ) =>
    new ProviderIntake(
      overrides.repository ?? repository,
      overrides.secrets ?? secrets,
      () => overrides.allowed !== false,
      newId,
    );
  return {
    actor,
    repository,
    management,
    source,
    grant,
    request,
    secrets,
    runner,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

test("signed Sentry acceptance persists one event and retries preserve the first evidence", async () => {
  const f = await fixture();
  const first = await f.runner().accept(f.request);
  assert.equal(first.state, "accepted");
  assert.deepEqual(await f.runner().accept(f.request), {
    ...first,
    state: "duplicate",
  });
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    const event = await tx.signals.get(first.signalIds[0]);
    assert.equal(event?.sourceId, f.source.id);
    assert.equal(event?.workspaceId, f.actor.workspaceId);
    const audit = await tx.audit.list({ limit: 100 });
    assert.equal(
      audit.items.filter((row) => row.action === "signal.accepted").length,
      1,
    );
  });
});
test("public receiver references do not authorize invalid signatures, route changes or foreign scopes", async () => {
  const f = await fixture();
  for (const request of [
    { ...f.request, signature: "0".repeat(64) },
    { ...f.request, provider: "grafana-signed" as const },
    { ...f.request, reference: "a".repeat(64) },
  ])
    await assert.rejects(f.runner().accept(request), { code: "invalid_token" });
  await assert.rejects(f.runner({ allowed: false }).accept(f.request), {
    code: "invalid_token",
  });
  const body = Buffer.from("not JSON");
  await assert.rejects(
    f.runner().accept({ ...f.request, body, signature: sign(body) }),
    { code: "invalid_input" },
  );
});
test("grant revocation, expiry or source edits during secret resolution prevent acceptance", async () => {
  for (const change of ["revoke", "expire", "edit"] as const) {
    const f = await fixture();
    const secrets: SourceVerificationSecrets = {
      async withSecret(use, consume) {
        if (change === "revoke")
          await f.management.revokeToken(f.actor, { id: f.grant.id });
        else if (change === "expire") f.advance(31 * 86400_000);
        else if (change === "edit")
          await f.management.updateProvider(f.actor, {
            id: f.source.id,
            expectedVersion: 1,
            intake: { mode: "sentry-hmac" },
            authSecretId: "fixture-secret",
          });
        return f.secrets.withSecret(use, consume);
      },
    };
    await assert.rejects(f.runner({ secrets }).accept(f.request), {
      code: "invalid_token",
    });
    const audit = await f.repository.transaction(f.actor.workspaceId, (tx) =>
      tx.audit.list({ limit: 100 }),
    );
    assert.equal(
      audit.items.some((row) => row.action === "signal.accepted"),
      false,
    );
  }
});
test("revoked secret metadata fails final authorization even when the MAC was valid", async () => {
  const f = await fixture();
  let available = true;
  const repository: SignalRepository = {
    findTokenContext: (hash) => f.repository.findTokenContext(hash),
    transaction: (scope, work) =>
      f.repository.transaction(scope, (tx) =>
        work({
          ...tx,
          sources: { ...tx.sources, hasUsableSecret: async () => available },
        }),
      ),
  };
  const secrets: SourceVerificationSecrets = {
    async withSecret(use, consume) {
      const result = await f.secrets.withSecret(use, consume);
      available = false;
      return result;
    },
  };
  await assert.rejects(f.runner({ repository, secrets }).accept(f.request), {
    code: "invalid_token",
  });
});
test("Grafana bearer batches commit atomically and reject credentials on the wrong source", async () => {
  const f = await fixture({ mode: "grafana-bearer" });
  const request = {
    ...f.request,
    body: grafana(["c6eadffa33fcdf37", "bc97ff14869b13e3"]),
  };
  const repository: SignalRepository = {
    findTokenContext: (hash) => f.repository.findTokenContext(hash),
    transaction: (scope, work) =>
      f.repository.transaction(scope, (tx) => {
        let inserts = 0;
        return work({
          ...tx,
          signals: {
            ...tx.signals,
            insert: async (event) => {
              if (++inserts === 2) throw new Error("storage unavailable");
              return tx.signals.insert(event);
            },
          },
        });
      }),
  };
  await assert.rejects(
    f.runner({ repository }).accept(request),
    /storage unavailable/,
  );
  const audit = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.audit.list({ limit: 100 }),
  );
  assert.equal(
    audit.items.some((row) => row.action === "signal.accepted"),
    false,
  );
  const accepted = await f.runner().accept(request);
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.signalIds.length, 2);
  assert.equal((await f.runner().accept(request)).state, "duplicate");
  await assert.rejects(f.runner().accept({ ...request, reference: "source" }), {
    code: "invalid_token",
  });
});
test("native GlitchTip receipts allow later identical observations with the same incident fingerprint", async () => {
  const f = await fixture({
    mode: "glitchtip",
    trackerOrigin: "https://errors.example.invalid",
  });
  const request = {
    ...f.request,
    body: bytes({
      text: "Private",
      attachments: [
        { title_link: "https://errors.example.invalid/team/issues/1" },
      ],
    }),
  };
  const first = await f.runner().accept(request);
  f.advance(60_000);
  const second = await f.runner().accept(request);
  assert.notDeepEqual(first.signalIds, second.signalIds);
  await f.repository.transaction(f.actor.workspaceId, async (tx) => {
    const a = await tx.signals.get(first.signalIds[0]);
    const b = await tx.signals.get(second.signalIds[0]);
    assert.equal(a?.fingerprint, b?.fingerprint);
    assert.notEqual(a?.observedAt, b?.observedAt);
    assert.equal(
      (await tx.audit.list({ limit: 100 })).items.filter(
        (row) => row.action === "signal.native.received",
      ).length,
      2,
    );
  });
});
test("provider HTTP errors never disclose broker failures and enforce content type and size", async () => {
  const f = await fixture();
  const request = { ...f.request, contentType: "application/json" };
  const http = new ProviderHttp(f.runner());
  assert.equal(
    (await http.accept({ ...request, contentType: "text/plain" })).status,
    415,
  );
  assert.equal(
    (await http.accept({ ...request, body: Buffer.alloc(256 * 1024 + 1) }))
      .status,
    413,
  );
  assert.equal(
    (await http.accept({ ...request, signature: "bad" })).status,
    401,
  );
  const broken = new ProviderHttp(
    f.runner({
      secrets: {
        withSecret: async () => {
          throw new Error("broker private detail");
        },
      },
    }),
  );
  assert.deepEqual(await broken.accept(request), {
    status: 503,
    body: { error: "unavailable" },
  });
  assert.equal((await http.accept(request)).status, 202);
  assert.equal((await http.accept(request)).status, 200);
});

test("Grafana signed intake uses database time and rejects expired signed timestamps", async () => {
  const f = await fixture({ mode: "grafana-hmac" });
  const body = grafana();
  const timestamp = String(Date.parse("2026-09-20T00:00:00.000Z") / 1000);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}:`)
    .update(body)
    .digest("hex");
  const request = { ...f.request, body, timestamp, signature };
  assert.equal((await f.runner().accept(request)).state, "accepted");
  f.advance(300_001);
  await assert.rejects(f.runner().accept(request), { code: "invalid_token" });
});

test("aborting during secret resolution prevents persistence", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const secrets: SourceVerificationSecrets = {
    async withSecret(use, consume) {
      const value = await f.secrets.withSecret(use, consume);
      controller.abort();
      return value;
    },
  };
  await assert.rejects(
    f.runner({ secrets }).accept({ ...f.request, signal: controller.signal }),
  );
  const audit = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.audit.list({ limit: 100 }),
  );
  assert.equal(
    audit.items.some((row) => row.action === "signal.accepted"),
    false,
  );
});

test("inbound secret claims require live, matching persisted source and receiver authority", async () => {
  const f = await fixture();
  const use: SourceVerificationUse = {
    workspaceId: f.actor.workspaceId,
    sourceId: f.source.id,
    sourceVersion: 1,
    grantId: f.grant.id,
    receiverHash: f.request.reference,
    secretId: "fixture-secret",
    signal: f.request.signal,
  };
  const grant = await f.repository.transaction(f.actor.workspaceId, (tx) =>
    tx.tokens.getByHash(f.request.reference),
  );
  const claim: SourceVerificationClaim = {
    source: f.source,
    grant,
    databaseNow: "2026-09-20T00:00:00.000Z",
    serviceEnabled: true,
    secret: { id: use.secretId, workspaceId: use.workspaceId, enabled: true },
  };
  assert.doesNotThrow(() => assertSourceVerificationClaim(use, claim));
  for (const change of [
    { source: { ...f.source, workspaceId: "foreign" } },
    { source: { ...f.source, version: 2 } },
    { source: { ...f.source, enabled: false } },
    { source: { ...f.source, authSecretId: "another-secret" } },
    { grant: { ...grant, tokenHash: "b".repeat(64) } },
    { grant: { ...grant, workspaceId: "foreign" } },
    { grant: { ...grant, sourceId: "another-source" } },
    { grant: { ...grant, id: "another-grant" } },
    { grant: { ...grant, revokedAt: claim.databaseNow } },
    { grant: { ...grant, expiresAt: claim.databaseNow } },
    { databaseNow: "invalid" },
    { serviceEnabled: false },
    { secret: { ...claim.secret, enabled: false } },
    { secret: { ...claim.secret, workspaceId: "foreign" } },
    { secret: { ...claim.secret, id: "another-secret" } },
  ])
    assert.throws(
      () => assertSourceVerificationClaim(use, { ...claim, ...change }),
      { code: "secret_unavailable" },
    );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      assertSourceVerificationClaim(
        { ...use, signal: controller.signal },
        claim,
      ),
    { code: "secret_unavailable" },
  );
});

test("grant expiry is checked after waiting for secret metadata locks", async () => {
  const f = await fixture();
  const repository: SignalRepository = {
    findTokenContext: (hash) => f.repository.findTokenContext(hash),
    transaction: (scope, work) =>
      f.repository.transaction(scope, (tx) =>
        work({
          ...tx,
          sources: {
            ...tx.sources,
            hasUsableSecret: async (id, version) => {
              f.advance(31 * 86400_000);
              return tx.sources.hasUsableSecret(id, version);
            },
          },
        }),
      ),
  };
  await assert.rejects(f.runner({ repository }).accept(f.request), {
    code: "invalid_token",
  });
});
