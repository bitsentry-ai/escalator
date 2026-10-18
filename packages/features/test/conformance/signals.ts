import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceIdSchema,
  workspaceSchema,
  serviceSchema,
  environmentSchema,
  signalSourceSchema,
  signalEventSchema,
  signalTokenSchema,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type {
  SignalRepository,
  SignalTransaction,
  DurableWorkStore,
} from "@bitsentry-escalator/features/application";
export interface SignalFixture {
  repository: SignalRepository;
  work: DurableWorkStore;
  dispose(): Promise<void>;
}
export async function seedSignalFixture(tx: SignalTransaction): Promise<void> {
  const dates = { createdAt: tx.now, updatedAt: tx.now };
  await tx.workspace.insert(
    workspaceSchema.parse({ id: tx.workspaceId, name: "Team", ...dates }),
  );
  await tx.services.insert(
    serviceSchema.parse({
      id: "service",
      workspaceId: tx.workspaceId,
      name: "API",
      key: "api",
      owningTeam: "Team",
      enabled: true,
      ...dates,
    }),
  );
  await tx.environments.insert(
    environmentSchema.parse({
      id: "production",
      workspaceId: tx.workspaceId,
      name: "Production",
      key: "production",
      isProduction: true,
      ...dates,
    }),
  );
  await tx.sources.insert(
    signalSourceSchema.parse({
      id: "source",
      workspaceId: tx.workspaceId,
      serviceId: "service",
      environmentId: "production",
      name: "Errors",
      kind: "generic",
      enabled: true,
      version: 1,
      grouping: "source-fingerprint",
      recovery: "explicit",
      recoveryHoldSeconds: 60,
      authSecretId: null,
      ...dates,
    }),
  );
}
export const fixtureSignal = (
  tx: SignalTransaction,
  id = "signal",
  eventId = "provider-event",
) =>
  signalEventSchema.parse({
    id,
    eventId,
    workspaceId: tx.workspaceId,
    sourceId: "source",
    serviceId: "service",
    environmentId: "production",
    version: 1,
    fingerprint: "checkout-error",
    observedAt: tx.now,
    receivedAt: tx.now,
    status: "active",
    severity: "critical",
    title: "Checkout error",
    evidence: { summary: "HTTP 500", attributes: [] },
  });
export const fixtureToken = (tx: SignalTransaction, hash = "a".repeat(64)) =>
  signalTokenSchema.parse({
    id: "token",
    workspaceId: tx.workspaceId,
    sourceId: "source",
    scope: "signal:write",
    tokenHash: hash,
    createdAt: tx.now,
    expiresAt: new Date(Date.parse(tx.now) + 86_400_000).toISOString(),
    revokedAt: null,
  });
export function signalConformance(
  name: string,
  create: () => Promise<SignalFixture>,
  options: {
    skip?: string;
    register?: (name: string, run: () => Promise<void>) => unknown;
  } = {},
): void {
  const register =
    options.register ??
    ((name, run) => test(name, { skip: options.skip }, run));
  const scenario = (
    title: string,
    run: (f: SignalFixture, a: WorkspaceId, b: WorkspaceId) => Promise<void>,
  ) =>
    register(`${name}: ${title}`, async () => {
      const fixture = await create();
      const a = workspaceIdSchema.parse(`signal_a_${randomUUID()}`);
      const b = workspaceIdSchema.parse(`signal_b_${randomUUID()}`);
      try {
        for (const scope of [a, b])
          await fixture.repository.transaction(scope, seedSignalFixture);
        await run(fixture, a, b);
      } finally {
        await fixture.dispose();
      }
    });
  scenario(
    "duplicate event preserves first evidence and isolates source keys by workspace",
    async ({ repository }, a, b) => {
      await repository.transaction(a, async (tx) => {
        assert.equal(await tx.signals.insert(fixtureSignal(tx)), "inserted");
        assert.equal(
          await tx.signals.insert({
            ...fixtureSignal(tx, "duplicate"),
            status: "recovered",
          }),
          "duplicate",
        );
        assert.equal((await tx.signals.get("signal"))?.status, "active");
        assert.equal(await tx.signals.get("duplicate"), undefined);
      });
      await repository.transaction(b, async (tx) => {
        assert.equal(await tx.signals.get("signal"), undefined);
        assert.equal(await tx.signals.insert(fixtureSignal(tx)), "inserted");
      });
    },
  );
  scenario(
    "source version compare-and-swap preserves the winning edit",
    async ({ repository }, scope) => {
      const results = await Promise.all(
        ["first", "second"].map((name) =>
          repository.transaction(scope, async (tx) => {
            const source = (await tx.sources.get("source"))!;
            return tx.sources.replace(
              { ...source, version: 2, name, updatedAt: tx.now },
              1,
            );
          }),
        ),
      );
      assert.equal(results.filter(Boolean).length, 1);
      await repository.transaction(scope, async (tx) =>
        assert.equal((await tx.sources.get("source"))?.version, 2),
      );
    },
  );
  scenario(
    "scope, source identity and foreign references fail closed",
    async ({ repository }, a, b) => {
      await assert.rejects(
        repository.transaction(a, async (tx) =>
          tx.signals.insert({ ...fixtureSignal(tx), workspaceId: b }),
        ),
        /scope_violation/,
      );
      await assert.rejects(
        repository.transaction(a, async (tx) =>
          tx.signals.insert({ ...fixtureSignal(tx), sourceId: "missing" }),
        ),
        /not_found/,
      );
      await assert.rejects(
        repository.transaction(a, async (tx) =>
          tx.signals.insert({
            ...fixtureSignal(tx),
            environmentId: environmentSchema.shape.id.parse("foreign"),
          }),
        ),
        /scope_violation/,
      );
      await assert.rejects(
        repository.transaction(a, async (tx) =>
          tx.sources.replace(
            {
              ...(await tx.sources.get("source"))!,
              kind: "grafana",
              version: 2,
            },
            1,
          ),
        ),
        /identity_change/,
      );
    },
  );
  scenario(
    "signal and durable work roll back together",
    async ({ repository, work }, scope) => {
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          await tx.signals.insert(fixtureSignal(tx));
          await tx.work.enqueue("job", {
            id: "process",
            kind: "signal.process",
            idempotencyKey: "process",
            payload: { signalId: "signal" },
            dueAt: tx.now,
          });
          throw new Error("interrupt before commit");
        }),
        /interrupt/,
      );
      await repository.transaction(scope, async (tx) =>
        assert.equal(await tx.signals.get("signal"), undefined),
      );
      assert.equal(
        await work.claim({
          workspaceId: scope,
          queue: "job",
          kinds: ["signal.process"],
          token: randomUUID(),
          leaseMs: 60_000,
        }),
        undefined,
      );
    },
  );
  scenario(
    "caught invalid operation poisons every pending write",
    async ({ repository }, scope) => {
      await assert.rejects(
        repository.transaction(scope, async (tx) => {
          await tx.signals.insert(fixtureSignal(tx));
          await assert.rejects(tx.sources.list({ limit: 0 }), /invalid_page/);
        }),
        /invalid_page/,
      );
      await repository.transaction(scope, async (tx) =>
        assert.equal(await tx.signals.get("signal"), undefined),
      );
    },
  );
  scenario(
    "escaped handles reject after the transaction closes",
    async ({ repository }, scope) => {
      const tx = await repository.transaction(scope, async (value) => value);
      await assert.rejects(tx.sources.get("source"), /closed_transaction/);
      await assert.rejects(tx.signals.get("signal"), /closed_transaction/);
      await assert.rejects(
        tx.tokens.getByHash("a".repeat(64)),
        /closed_transaction/,
      );
    },
  );
  scenario(
    "token context is trusted, hash uniqueness global and revocation scoped",
    async ({ repository }, a, b) => {
      await repository.transaction(a, async (tx) =>
        tx.tokens.insert(fixtureToken(tx)),
      );
      assert.deepEqual(await repository.findTokenContext("a".repeat(64)), {
        workspaceId: a,
        sourceId: "source",
        id: "token",
      });
      await repository.transaction(b, async (tx) => {
        assert.equal(await tx.tokens.getByHash("a".repeat(64)), undefined);
        assert.equal(await tx.tokens.revoke("token"), false);
      });
      await assert.rejects(
        repository.transaction(b, async (tx) =>
          tx.tokens.insert(fixtureToken(tx)),
        ),
        /already_exists/,
      );
      await repository.transaction(a, async (tx) => {
        assert.equal(await tx.tokens.revoke("token"), true);
        const first = await tx.tokens.getByHash("a".repeat(64));
        assert.equal(await tx.tokens.revoke("token"), true);
        assert.equal(
          (await tx.tokens.getByHash("a".repeat(64)))?.revokedAt,
          first?.revokedAt,
        );
        assert.ok(Date.parse(first!.revokedAt!) >= Date.parse(tx.now));
      });
    },
  );
  scenario(
    "received time comes from the transaction, not the provider clock",
    async ({ repository }, scope) => {
      await assert.rejects(
        repository.transaction(scope, async (tx) =>
          tx.signals.insert({
            ...fixtureSignal(tx),
            receivedAt: new Date(Date.parse(tx.now) - 1000).toISOString(),
          }),
        ),
        /invalid_timestamp/,
      );
      await repository.transaction(scope, async (tx) =>
        assert.equal(
          await tx.signals.insert({
            ...fixtureSignal(tx),
            observedAt: new Date(Date.parse(tx.now) - 1000).toISOString(),
          }),
          "inserted",
        ),
      );
    },
  );
  scenario(
    "grant inventory pages within one source and tenant and retains revocation metadata",
    async ({ repository }, a, b) => {
      await repository.transaction(a, async (tx) => {
        const source = (await tx.sources.get("source"))!;
        await tx.sources.insert({ ...source, id: "other" });
        await tx.tokens.insert({
          ...fixtureToken(tx, "1".repeat(64)),
          id: "grant-a",
        });
        await tx.tokens.insert({
          ...fixtureToken(tx, "2".repeat(64)),
          id: "grant-b",
        });
        await tx.tokens.insert({
          ...fixtureToken(tx, "3".repeat(64)),
          id: "other-grant",
          sourceId: "other",
        });
      });
      await repository.transaction(b, async (tx) => {
        await tx.tokens.insert({
          ...fixtureToken(tx, "4".repeat(64)),
          id: "foreign-grant",
        });
      });
      await repository.transaction(a, async (tx) => {
        const page = await tx.tokens.list("source", { limit: 1 });
        assert.deepEqual(
          page.items.map((row) => row.id),
          ["grant-a"],
        );
        assert.equal(page.next, "grant-a");
        const next = await tx.tokens.list("source", {
          limit: 1,
          after: page.next!,
        });
        assert.deepEqual(
          next.items.map((row) => row.id),
          ["grant-b"],
        );
        assert.equal(next.next, null);
        assert.ok(
          next.items.every(
            (row) => row.workspaceId === a && row.sourceId === "source",
          ),
        );
        await tx.tokens.revoke("grant-a");
        assert.ok(
          (await tx.tokens.list("source", { limit: 10 })).items[0].revokedAt,
        );
      });
      await repository.transaction(b, async (tx) =>
        assert.deepEqual(
          (await tx.tokens.list("source", { limit: 10 })).items.map(
            (row) => row.id,
          ),
          ["foreign-grant"],
        ),
      );
    },
  );
  scenario(
    "grant inventory rejects missing sources and unbounded pages",
    async ({ repository }, scope) => {
      await assert.rejects(
        repository.transaction(scope, (tx) =>
          tx.tokens.list("missing", { limit: 10 }),
        ),
        /not_found/,
      );
      await assert.rejects(
        repository.transaction(scope, (tx) =>
          tx.tokens.list("source", { limit: 0 }),
        ),
        /invalid_page/,
      );
      await assert.rejects(
        repository.transaction(scope, (tx) =>
          tx.tokens.list("source", { limit: 101 }),
        ),
        /invalid_page/,
      );
    },
  );
}
