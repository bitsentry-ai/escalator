import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  workspaceIdSchema,
  SIGNAL_INGRESS_MAX_BYTES,
} from "../src/contracts/index.js";
import {
  SignalIntake,
  signalTokenDigest,
  parseSignalBody,
} from "../src/application/signals/ingest.js";
import type { SignalRepository } from "../src/application/signals/ports.js";
import { MemorySignalRepository } from "./conformance/memory-signals.js";
import { seedSignalFixture, fixtureToken } from "./conformance/signals.js";

const scope = workspaceIdSchema.parse("ingest-workspace");
const input = {
  version: 1,
  eventId: "event-1",
  fingerprint: "checkout",
  status: "active",
  severity: "critical",
  title: "Checkout failed",
  observedAt: "2026-09-19T00:00:00.000Z",
  evidence: { summary: "HTTP 500", attributes: [] },
};
async function setup() {
  let time = Date.parse("2026-09-20T00:00:00.000Z");
  const repository = new MemorySignalRepository(() => new Date(time));
  const token = `esi_${randomBytes(32).toString("base64url")}`;
  await repository.transaction(scope, async (tx) => {
    await seedSignalFixture(tx);
    await tx.tokens.insert(fixtureToken(tx, signalTokenDigest(token)!));
  });
  return {
    repository,
    token,
    intake: new SignalIntake(repository),
    advance: () => {
      time += 86_400_000;
    },
  };
}
test("concurrent duplicate ingress commits one event, work item and audit", async () => {
  const { repository, token, intake } = await setup();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => intake.accept("source", token, input)),
  );
  assert.equal(results.filter((x) => x.state === "accepted").length, 1);
  assert.equal(new Set(results.map((x) => x.signalId)).size, 1);
  await intake.accept("source", token, {
    ...input,
    status: "recovered",
    title: "Changed retry",
  });
  await repository.transaction(scope, async (tx) => {
    const event = await tx.signals.get(results[0].signalId);
    assert.equal(event?.status, "active");
    assert.equal(event?.observedAt, input.observedAt);
    assert.equal(event?.receivedAt, tx.now);
    const audit = await tx.audit.list({ limit: 100 });
    assert.equal(audit.items.length, 1);
    assert.equal(JSON.stringify(audit).includes(token), false);
  });
  const request = {
    workspaceId: scope,
    queue: "job" as const,
    kinds: ["signal.process"],
    token: "claim",
    leaseMs: 60_000,
  };
  const lease = await repository.foundation.claim(request);
  assert.deepEqual(lease?.payload, { signalId: results[0].signalId });
  assert.equal(
    await repository.foundation.claim({ ...request, token: "second" }),
    undefined,
  );
});
test("invalid grants and body-selected scope cannot enqueue work", async () => {
  const { repository, token, intake } = await setup();
  for (const credential of [
    "",
    "raw-token",
    token + "=",
    `esi_${randomBytes(32).toString("base64url")}`,
  ])
    await assert.rejects(
      intake.accept("source", credential, input),
      /invalid_token/,
    );
  await assert.rejects(intake.accept("foreign", token, input), /invalid_token/);
  await assert.rejects(
    intake.accept("source", token, { ...input, workspaceId: "foreign" }),
    /invalid_input/,
  );
  await repository.transaction(scope, async (tx) =>
    assert.equal((await tx.audit.list({ limit: 100 })).items.length, 0),
  );
});
test("grant revocation between context lookup and acceptance fails closed", async () => {
  const { repository, token } = await setup();
  const wrapped: SignalRepository = {
    transaction: (scope, run) => repository.transaction(scope, run),
    findTokenContext: async (hash) => {
      const context = await repository.findTokenContext(hash);
      await repository.transaction(scope, (tx) => tx.tokens.revoke("token"));
      return context;
    },
  };
  await assert.rejects(
    new SignalIntake(wrapped).accept("source", token, input),
    /invalid_token/,
  );
});
test("token expiry is checked with live time after source lock acquisition", async () => {
  const { repository, token, advance } = await setup();
  const wrapped: SignalRepository = {
    findTokenContext: (hash) => repository.findTokenContext(hash),
    transaction: (scope, run) =>
      repository.transaction(scope, (tx) =>
        run({
          ...tx,
          sources: {
            ...tx.sources,
            lock: async (id) => {
              const source = await tx.sources.lock(id);
              advance();
              return source;
            },
          },
        }),
      ),
  };
  await assert.rejects(
    new SignalIntake(wrapped).accept("source", token, input),
    /invalid_token/,
  );
});
test("disabling a source prevents new signal acceptance", async () => {
  const { repository, token, intake } = await setup();
  await repository.transaction(scope, async (tx) => {
    const source = (await tx.sources.get("source"))!;
    await tx.sources.replace({ ...source, enabled: false, version: 2 }, 1);
  });
  await assert.rejects(intake.accept("source", token, input), /invalid_token/);
});
test("failed audit rolls back event and processing intent, allowing retry", async () => {
  const { repository, token, intake } = await setup();
  const wrapped: SignalRepository = {
    findTokenContext: (hash) => repository.findTokenContext(hash),
    transaction: (scope, run) =>
      repository.transaction(scope, (tx) =>
        run({
          ...tx,
          audit: {
            ...tx.audit,
            append: async () => {
              throw new Error("audit unavailable");
            },
          },
        }),
      ),
  };
  await assert.rejects(
    new SignalIntake(wrapped).accept("source", token, input),
    /audit unavailable/,
  );
  assert.equal((await intake.accept("source", token, input)).state, "accepted");
});
test("byte limits precede parsing and invalid UTF-8 is rejected", () => {
  assert.throws(
    () => parseSignalBody(new Uint8Array(SIGNAL_INGRESS_MAX_BYTES + 1)),
    /body_too_large/,
  );
  assert.throws(
    () => parseSignalBody(Uint8Array.from([0xff])),
    /invalid_input/,
  );
  assert.throws(() => parseSignalBody(Buffer.from("{")), /invalid_input/);
  assert.deepEqual(parseSignalBody(Buffer.from(JSON.stringify(input))), input);
});

test("revocation uses live time even when the transaction began earlier", async () => {
  const { repository, token, advance } = await setup();
  await repository.transaction(scope, async (tx) => {
    const before = tx.now;
    advance();
    assert.equal(await tx.tokens.revoke("token"), true);
    const grant = await tx.tokens.getByHash(signalTokenDigest(token)!);
    assert.equal(grant?.revokedAt, await tx.currentTime());
    assert.ok(Date.parse(grant!.revokedAt!) > Date.parse(before));
  });
});
