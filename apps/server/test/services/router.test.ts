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
  type Actor,
} from "@bitsentry-escalator/features/contracts";
import type {
  ConfigurationUseCases,
  IncidentUseCases,
  ServiceUseCases,
} from "@bitsentry-escalator/features/application";
import type { LocalAuthService } from "../../src/platform/auth/auth.service.js";
import { servicesRouter } from "../../src/features/services/services.router.js";
function fixture() {
  const req = {
    session: { account: { accountId: "owner", authVersion: 2 } },
  } as unknown as Request;
  const actors: Actor[] = [];
  const auth = {
    async current() {
      return { id: "owner", role: "administrator" };
    },
  };
  const services = {
    async listServices(actor: Actor) {
      actors.push(actor);
      return { items: [], next: null };
    },
    async createService(actor: Actor) {
      actors.push(actor);
      throw Object.assign(new Error(), { code: "already_exists" });
    },
    async getService(actor: Actor) {
      actors.push(actor);
      throw Object.assign(new Error(), { code: "not_found" });
    },
  };
  const caller = servicesRouter.createCaller({
    req,
    res: {} as Response,
    auth: auth as unknown as LocalAuthService,
    incidents: {} as IncidentUseCases,
    signals: {} as SignalManagement,
    detection: {} as DetectionManagement,
    probes: {} as ProbeManagement,
    metrics: {} as MetricManagement,
    retention: {} as RetentionManagement,
    heartbeats: {} as HeartbeatManagement,
    secretWriter: {} as PostgresSecretWriter,
    configuration: {} as ConfigurationUseCases,
    services: services as unknown as ServiceUseCases,
    workspaceId: workspaceIdSchema.parse("local"),
  });
  return { req, actors, auth, caller };
}
test("Services requires a current session and derives the actor from the host", async () => {
  const f = fixture();
  await f.caller.list({});
  assert.deepEqual(f.actors, [
    { workspaceId: "local", responderId: "owner", role: "administrator" },
  ]);
  delete f.req.session.account;
  await assert.rejects(f.caller.list({}), { code: "UNAUTHORIZED" });
  assert.equal(f.actors.length, 1);
});
test("Services rejects scope injection before calling the use case", async () => {
  const f = fixture();
  await assert.rejects(
    f.caller.create({
      name: "API",
      key: "api",
      owningTeam: "Platform",
      workspaceId: "other",
    } as never),
    { code: "BAD_REQUEST" },
  );
  assert.equal(f.actors.length, 0);
});
test("revoked proof and scoped missing/duplicate services have safe errors", async () => {
  const f = fixture();
  await assert.rejects(f.caller.get("other"), { code: "NOT_FOUND" });
  await assert.rejects(
    f.caller.create({ name: "API", key: "api", owningTeam: "Platform" }),
    { code: "CONFLICT" },
  );
  f.auth.current = async () => {
    throw Object.assign(new Error("private"), {
      code: "authentication_failed",
    });
  };
  await assert.rejects(f.caller.list({}), { code: "UNAUTHORIZED" });
  assert.equal(f.actors.length, 2);
});
