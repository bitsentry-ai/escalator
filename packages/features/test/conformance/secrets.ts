import test from "node:test";
import assert from "node:assert/strict";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
import type {
  SecretStore,
  SecretUse,
  PersistedSecretClaim,
} from "@bitsentry-escalator/features/application";
export const secretFixtureValue = "private-fixture-value";
export function secretFixtureSeed() {
  const controller = new AbortController();
  const workspaceId = workspaceIdSchema.parse("org_secret_fixture");
  const request: SecretUse = {
    workspaceId,
    secretId: "secret_fixture",
    workId: "work_fixture",
    queue: "outbox",
    claimToken: "current-token",
    signal: controller.signal,
  };
  const claim: PersistedSecretClaim = {
    workspaceId,
    workId: request.workId,
    queue: request.queue,
    state: "running",
    token: request.claimToken,
    databaseNow: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    approvedSecretIds: [request.secretId],
  };
  return { request, claim, controller };
}
export interface SecretFixture extends ReturnType<typeof secretFixtureSeed> {
  store: SecretStore;
  reads(): number;
  revoke(): void;
}
export function secretStoreConformance(
  name: string,
  create: () => SecretFixture,
  register: (name: string, run: () => Promise<void>) => unknown = (name, run) =>
    test(name, run),
) {
  async function denied(store: SecretStore, request: SecretUse) {
    let invoked = false;
    await assert.rejects(
      store.withSecret(request, async () => {
        invoked = true;
      }),
      { code: "secret_unavailable" },
    );
    assert.equal(invoked, false);
  }
  register(
    `${name}: secret bytes live only through the authorized callback`,
    async () => {
      const f = create();
      let held: Uint8Array | undefined;
      const result = await f.store.withSecret(f.request, async (bytes) => {
        held = bytes;
        assert.equal(Buffer.from(bytes).toString(), secretFixtureValue);
        return { accepted: true };
      });
      assert.deepEqual(result, { accepted: true });
      assert.ok(held?.every((byte) => byte === 0));
    },
  );
  register(
    `${name}: scope, approved binding and live claim are required`,
    async () => {
      for (const patch of [
        { workspaceId: workspaceIdSchema.parse("org_other") },
        { secretId: "secret_other" },
        { claimToken: "stale" },
        { workId: "other_work" },
        { queue: "job" as const },
      ]) {
        const f = create();
        await denied(f.store, { ...f.request, ...patch });
        assert.equal(f.reads(), 0);
      }
      for (const patch of [
        { state: "cancelled" },
        { expiresAt: "2000-01-01T00:00:00.000Z" },
        { approvedSecretIds: [] },
        { approvedSecretIds: { secret_fixture: true } },
      ]) {
        const f = create();
        Object.assign(f.claim, patch);
        await denied(f.store, f.request);
        assert.equal(f.reads(), 0);
      }
    },
  );
  register(`${name}: abort and disabled credentials deny use`, async () => {
    for (const revoke of [false, true]) {
      const f = create();
      if (revoke) f.revoke();
      else f.controller.abort();
      await denied(f.store, f.request);
      assert.equal(f.reads(), 0);
    }
  });
  register(
    `${name}: provider errors cannot expose plaintext and owned bytes are cleared`,
    async () => {
      const f = create();
      let held: Uint8Array | undefined;
      await assert.rejects(
        f.store.withSecret(f.request, async (bytes) => {
          held = bytes;
          throw new Error(secretFixtureValue);
        }),
        (error: unknown) =>
          error instanceof Error &&
          !error.message.includes(secretFixtureValue) &&
          "code" in error &&
          error.code === "secret_unavailable",
      );
      assert.ok(held?.every((byte) => byte === 0));
    },
  );
}
