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
  type Actor,
} from "@bitsentry-escalator/features/contracts";
import type {
  ConfigurationUseCases,
  IncidentUseCases,
  ServiceUseCases,
} from "@bitsentry-escalator/features/application";
import type { LocalAuthService } from "../../src/platform/auth/auth.service.js";
import { configurationRouter } from "../../src/features/configuration/configuration.router.js";
test("standalone configuration routes use current identity and reject injected scope", async () => {
  const req = {
    session: { account: { accountId: "owner", authVersion: 1 } },
  } as unknown as Request;
  const actors: Actor[] = [];
  let failure: string | undefined;
  const configuration = {
    previews: async (actor: Actor, input: unknown) => {
      assert.equal(actor.workspaceId, "local");
      assert.equal(actor.responderId, "owner");
      assert.deepEqual(input, { scheduleId: "schedule", limit: 2 });
      return { items: [], next: null };
    },
    writeSchedule: async (actor: Actor) => {
      actors.push(actor);
      if (failure) throw Object.assign(new Error(), { code: failure });
      return { id: "schedule", version: 1 };
    },
  } as unknown as ConfigurationUseCases;
  const caller = configurationRouter.createCaller({
    req,
    res: {} as Response,
    services: {} as ServiceUseCases,
    incidents: {} as IncidentUseCases,
    configuration,
    signals: {} as SignalManagement,
    detection: {} as DetectionManagement,
    probes: {} as ProbeManagement,
    secretWriter: {} as PostgresSecretWriter,
    workspaceId: workspaceIdSchema.parse("local"),
    auth: {
      current: async () => ({ id: "owner", role: "administrator" }),
    } as unknown as LocalAuthService,
  });
  assert.deepEqual(
    await caller.previews({ scheduleId: "schedule", limit: 2 }),
    { items: [], next: null },
  );
  const input = {
    id: "schedule",
    serviceId: "api",
    name: "Primary",
    enabled: true,
    rotations: [],
    overrides: [],
    expectedVersion: null,
  };
  await caller.writeSchedule(input);
  assert.deepEqual(actors, [
    { workspaceId: "local", responderId: "owner", role: "administrator" },
  ]);
  await assert.rejects(
    caller.writeSchedule({ ...input, workspaceId: "foreign" } as never),
    { code: "BAD_REQUEST" },
  );
  assert.equal(actors.length, 1);
  for (const [code, result] of [
    ["conflict", "CONFLICT"],
    ["stale_preview", "PRECONDITION_FAILED"],
    ["invalid_schedule", "BAD_REQUEST"],
    ["invalid_configuration", "BAD_REQUEST"],
  ]) {
    failure = code;
    await assert.rejects(caller.writeSchedule(input), { code: result });
  }
  delete req.session.account;
  await assert.rejects(caller.writeSchedule(input), { code: "UNAUTHORIZED" });
});
