import { randomBytes } from "node:crypto";
import {
  hasCapability,
  heartbeatSchema,
  heartbeatGrantSchema,
  signalSourceSchema,
  type Actor,
  type Heartbeat,
} from "../../contracts/index.js";
import {
  heartbeatGrantPageSchema,
  createHeartbeatSchema,
  updateHeartbeatSchema,
  heartbeatIdSchema,
  heartbeatPageSchema,
  disableHeartbeatSchema,
  issueHeartbeatGrantSchema,
  revokeHeartbeatGrantSchema,
  type CreateHeartbeatInput,
  type UpdateHeartbeatInput,
} from "../../contracts/heartbeat-inputs.js";
import { PersistenceError } from "../ports/persistence.js";
import type {
  HeartbeatRepository,
  HeartbeatTransaction,
} from "./heartbeat-ports.js";
import { configureHeartbeat } from "./heartbeat.js";
import {
  heartbeatTokenHash,
  writeHeartbeatDeadline,
} from "./heartbeat-intake.js";
export class HeartbeatManagementError extends Error {
  constructor(readonly code: "forbidden" | "conflict" | "invalid_expiry") {
    super(code);
  }
}
function authorize(actor: Actor, write = false) {
  if (!hasCapability(actor.role, write ? "service:manage" : "service:read"))
    throw new HeartbeatManagementError("forbidden");
}
export class HeartbeatManagement {
  constructor(
    private readonly repository: HeartbeatRepository,
    private readonly newId: () => string,
  ) {}
  private audit(
    tx: HeartbeatTransaction,
    actor: Actor,
    probe: Heartbeat,
    action: string,
    grantId?: string,
  ) {
    return tx.audit.append({
      id: this.newId(),
      workspaceId: actor.workspaceId,
      actor: { kind: "responder", responderId: actor.responderId },
      action,
      subjectType: "heartbeat",
      subjectId: probe.id,
      recordedAt: tx.now,
      metadata: {
        version: probe.version,
        enabled: probe.enabled,
        ...(grantId ? { grantId } : {}),
      },
    });
  }
  async list(actor: Actor, input: { after?: string; limit?: number } = {}) {
    authorize(actor);
    const page = heartbeatPageSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.heartbeats.list(page),
    );
  }
  async get(actor: Actor, input: { id: string }) {
    authorize(actor);
    const { id } = heartbeatIdSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const probe = await tx.heartbeats.get(id);
      if (!probe) throw new PersistenceError("not_found");
      return { probe, state: (await tx.heartbeats.state(id)) ?? null };
    });
  }
  async create(actor: Actor, input: CreateHeartbeatInput) {
    authorize(actor, true);
    const fields = createHeartbeatSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const probe = heartbeatSchema.parse({
        ...fields,
        id: this.newId(),
        sourceId: this.newId(),
        workspaceId: actor.workspaceId,
        version: 1,
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      await tx.sources.insert(
        signalSourceSchema.parse({
          id: probe.sourceId,
          workspaceId: actor.workspaceId,
          serviceId: probe.serviceId,
          environmentId: probe.environmentId,
          name: probe.name,
          kind: "heartbeat",
          enabled: probe.enabled,
          version: 1,
          grouping: "source-fingerprint",
          recovery: "explicit",
          recoveryHoldSeconds: 60,
          authSecretId: null,
          createdAt: tx.now,
          updatedAt: tx.now,
        }),
      );
      return this.save(tx, actor, probe, null, "heartbeat.created");
    });
  }
  async update(actor: Actor, input: UpdateHeartbeatInput) {
    authorize(actor, true);
    const { id, expectedVersion, ...fields } =
      updateHeartbeatSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const current = await tx.heartbeats.lock(id);
      if (!current) throw new PersistenceError("not_found");
      if (current.version !== expectedVersion)
        throw new HeartbeatManagementError("conflict");
      return this.save(
        tx,
        actor,
        {
          ...current,
          ...fields,
          version: current.version + 1,
          updatedAt: tx.now,
        },
        current.version,
        "heartbeat.updated",
      );
    });
  }
  async disable(actor: Actor, input: { id: string; expectedVersion: number }) {
    authorize(actor, true);
    const { id, expectedVersion } = disableHeartbeatSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const current = await tx.heartbeats.lock(id);
      if (!current) throw new PersistenceError("not_found");
      if (current.version !== expectedVersion)
        throw new HeartbeatManagementError("conflict");
      return this.save(
        tx,
        actor,
        {
          ...current,
          enabled: false,
          version: current.version + 1,
          updatedAt: tx.now,
        },
        current.version,
        "heartbeat.disabled",
      );
    });
  }
  private async save(
    tx: HeartbeatTransaction,
    actor: Actor,
    probe: Heartbeat,
    expected: number | null,
    action: string,
  ) {
    const old = await tx.heartbeats.state(probe.id);
    if (!(await tx.heartbeats.put(probe, expected)))
      throw new HeartbeatManagementError("conflict");
    if (expected !== null) {
      const source = await tx.sources.get(probe.sourceId);
      if (!source) throw new PersistenceError("not_found");
      if (
        !(await tx.sources.replace(
          {
            ...source,
            name: probe.name,
            enabled: probe.enabled,
            version: source.version + 1,
            updatedAt: tx.now,
          },
          source.version,
        ))
      )
        throw new HeartbeatManagementError("conflict");
    }
    const next = configureHeartbeat(probe, old, tx.now);
    await tx.heartbeats.putState(next);
    await writeHeartbeatDeadline(tx, next, old);
    await this.audit(tx, actor, probe, action);
    return probe;
  }
  async grants(
    actor: Actor,
    input: { id: string; after?: string; limit?: number },
  ) {
    authorize(actor, true);
    const { id, ...page } = heartbeatGrantPageSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const result = await tx.heartbeats.grants(id, page);
      return {
        next: result.next,
        items: result.items.map(
          ({ id, probeId, scope, createdAt, expiresAt, revokedAt }) => ({
            id,
            probeId,
            scope,
            createdAt,
            expiresAt,
            revokedAt,
          }),
        ),
      };
    });
  }
  async issueGrant(actor: Actor, input: { id: string; expiresAt: string }) {
    authorize(actor, true);
    const fields = issueHeartbeatGrantSchema.parse(input);
    const token = `ehb_${randomBytes(32).toString("base64url")}`;
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const probe = await tx.heartbeats.lock(fields.id);
      if (!probe) throw new PersistenceError("not_found");
      const expiry = Date.parse(fields.expiresAt);
      if (
        expiry <= Date.parse(await tx.currentTime()) ||
        expiry - Date.parse(tx.now) > 90 * 86400000
      )
        throw new HeartbeatManagementError("invalid_expiry");
      const grant = heartbeatGrantSchema.parse({
        id: this.newId(),
        workspaceId: actor.workspaceId,
        probeId: probe.id,
        tokenHash: heartbeatTokenHash(token),
        scope: "heartbeat:write",
        createdAt: tx.now,
        expiresAt: fields.expiresAt,
        revokedAt: null,
      });
      await tx.heartbeats.insertGrant(grant);
      await this.audit(tx, actor, probe, "heartbeat.grant_issued", grant.id);
      return { id: grant.id, token, expiresAt: grant.expiresAt };
    });
  }
  async revokeGrant(actor: Actor, input: { id: string; grantId: string }) {
    authorize(actor, true);
    const fields = revokeHeartbeatGrantSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const probe = await tx.heartbeats.lock(fields.id);
      if (!probe) throw new PersistenceError("not_found");
      await tx.heartbeats.revokeGrant(probe.id, fields.grantId);
      await this.audit(
        tx,
        actor,
        probe,
        "heartbeat.grant_revoked",
        fields.grantId,
      );
      return { revoked: true };
    });
  }
}
