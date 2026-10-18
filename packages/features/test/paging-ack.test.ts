import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  acknowledgementDigest,
  PageAcknowledgements,
} from "../src/application/paging/acknowledge.js";
import type { PagingRepository } from "../src/application/paging/persistence.js";
import { MemoryPagingRepository } from "./conformance/memory-paging.js";
import { seedPagingFixture } from "./conformance/paging.js";
import {
  workspaceIdSchema,
  recipientDeliverySchema,
} from "../src/contracts/index.js";

test("acknowledgement credentials require canonical 256-bit base64url", () => {
  const token = randomBytes(32).toString("base64url");
  assert.match(acknowledgementDigest(token)!, /^[a-f0-9]{64}$/);
  for (const invalid of [
    token + "=",
    token.slice(1),
    "a".repeat(44),
    "_".repeat(43),
    " ".repeat(43),
  ])
    assert.equal(acknowledgementDigest(invalid), undefined);
});
test("a token expiring during the page-lock wait cannot acknowledge", async () => {
  let now = new Date("2026-09-20T00:00:00.000Z");
  const repo = new MemoryPagingRepository({ now: () => now });
  const scope = workspaceIdSchema.parse("expiry-test");
  const token = randomBytes(32).toString("base64url");
  await repo.transaction(scope, seedPagingFixture);
  await repo.transaction(scope, async (tx) => {
    const grant = (await tx.grants.get("grant"))!;
    await tx.grants.insert({
      ...grant,
      id: "expires",
      tokenDigest: acknowledgementDigest(token)!,
      expiresAt: new Date(now.getTime() + 1000).toISOString(),
    });
  });
  const delayed: PagingRepository = {
    transaction: (workspace, run) =>
      repo.transaction(workspace, (tx) =>
        run({
          ...tx,
          pages: {
            ...tx.pages,
            lock: async (id) => {
              const page = await tx.pages.lock(id);
              now = new Date(now.getTime() + 1000);
              return page;
            },
          },
        }),
      ),
  };
  assert.deepEqual(
    await new PageAcknowledgements(delayed).acknowledge(scope, token),
    { state: "invalid" },
  );
  await repo.transaction(scope, async (tx) => {
    assert.equal((await tx.pages.get("page"))?.state, "open");
    assert.equal((await tx.audit.list({ limit: 10 })).items.length, 0);
  });
});

test("cancellation intents always retain the frozen credential reference", async () => {
  const { cancelDeliveryWork } =
    await import("../src/application/paging/cancel.js");
  const repo = new MemoryPagingRepository({
    now: () => new Date("2026-09-20T00:00:00.000Z"),
  });
  const scope = workspaceIdSchema.parse("cancel-secret");
  await repo.transaction(scope, seedPagingFixture);
  await repo.transaction(scope, async (tx) => {
    const delivery = (await tx.deliveries.get("delivery"))!;
    assert.equal(
      recipientDeliverySchema.safeParse({ ...delivery, secretId: null })
        .success,
      false,
    );
    const { secretId: _secretId, ...missing } = delivery;
    assert.equal(recipientDeliverySchema.safeParse(missing).success, false);
    await cancelDeliveryWork(tx, [delivery]);
  });
  const lease = await repo.foundation.claim({
    workspaceId: scope,
    queue: "job",
    kinds: ["paging.cancel"],
    token: "cancel-claim",
    leaseMs: 5000,
  });
  assert.equal(lease?.payload.secretId, "secret");
  assert.deepEqual(lease?.payload.approvedSecretIds, ["secret"]);
});
