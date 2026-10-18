import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  signalSourceSchema,
  workspaceIdSchema,
} from "@bitsentry-escalator/features/contracts";
import { postgresSignalStore } from "../../src/platform/database/postgres-signals.store.js";
test("ordinary source reads succeed while an intake or edit lock is contended", async () => {
  const scope = workspaceIdSchema.parse("source-read");
  const source = signalSourceSchema.parse({
    id: "source",
    workspaceId: scope,
    serviceId: "api",
    environmentId: "prod",
    name: "Errors",
    kind: "generic",
    enabled: true,
    version: 1,
    grouping: "source-fingerprint",
    recovery: "explicit",
    recoveryHoldSeconds: 60,
    authSecretId: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  const connection = {
    query: async (sql: string) => {
      if (sql.includes("FOR UPDATE")) throw new Error("lock timeout");
      return { rows: [{ data: source }], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const store = postgresSignalStore(connection, scope);
  assert.deepEqual(await store.getSource("source"), source);
  await assert.rejects(store.getSource("source", true), /lock timeout/);
});
