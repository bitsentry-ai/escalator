import {
  listSignalTokensSchema,
  signalGrantSummarySchema,
  type ListSignalTokensInput,
} from "../../contracts/signal-grants.js";
import {
  providerSourceKind,
  needsManualProviderRecovery,
  usesProviderSignature,
} from "../../contracts/intake-config.js";
import {
  createProviderSourceSchema,
  updateProviderSourceSchema,
  type CreateProviderSourceInput,
  type UpdateProviderSourceInput,
} from "../../contracts/provider-source-inputs.js";
import { randomBytes } from "node:crypto";
import {
  hasCapability,
  signalSourceSchema,
  signalTokenSchema,
  type Actor,
} from "../../contracts/index.js";
import {
  createSignalSourceSchema,
  updateSignalSourceSchema,
  signalSourceIdSchema,
  signalSourcePageSchema,
  issueSignalTokenSchema,
  type CreateSignalSourceInput,
  type UpdateSignalSourceInput,
  type IssueSignalTokenInput,
} from "../../contracts/signal-management.js";
import { PersistenceError } from "../ports/persistence.js";
import type { SignalRepository, SignalTransaction } from "./ports.js";
import { signalTokenDigest } from "./ingest.js";

export class SignalManagementError extends Error {
  constructor(
    readonly code:
      | "forbidden"
      | "conflict"
      | "source_disabled"
      | "source_kind"
      | "invalid_configuration",
  ) {
    super(code);
  }
}
function authorize(actor: Actor, write: boolean) {
  if (!hasCapability(actor.role, write ? "service:manage" : "service:read"))
    throw new SignalManagementError("forbidden");
}
/** Hosts supply trusted actors; every change and its redacted audit commit together. */
export class SignalManagement {
  constructor(
    private readonly repository: SignalRepository,
    private readonly newId: () => string,
  ) {}
  private audit(
    tx: SignalTransaction,
    actor: Actor,
    action: string,
    subjectType: string,
    subjectId: string,
  ) {
    return tx.audit.append({
      id: this.newId(),
      workspaceId: actor.workspaceId,
      actor: { kind: "responder", responderId: actor.responderId },
      action,
      subjectType,
      subjectId,
      recordedAt: tx.now,
      metadata: {},
    });
  }
  async list(actor: Actor, input: { after?: string; limit?: number } = {}) {
    authorize(actor, false);
    const query = signalSourcePageSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, (tx) =>
      tx.sources.list(query),
    );
  }
  async listTokens(actor: Actor, input: ListSignalTokensInput) {
    authorize(actor, true);
    const { sourceId, ...page } = listSignalTokensSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const result = await tx.tokens.list(sourceId, page);
      return {
        next: result.next,
        items: result.items.map(
          ({ id, sourceId, scope, createdAt, expiresAt, revokedAt }) =>
            signalGrantSummarySchema.parse({
              id,
              sourceId,
              scope,
              createdAt,
              expiresAt,
              revokedAt,
            }),
        ),
      };
    });
  }
  async get(actor: Actor, input: { id: string }) {
    authorize(actor, false);
    const { id } = signalSourceIdSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const value = await tx.sources.get(id);
      if (!value) throw new PersistenceError("not_found");
      return value;
    });
  }
  async create(actor: Actor, input: CreateSignalSourceInput) {
    authorize(actor, true);
    const fields = createSignalSourceSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const value = signalSourceSchema.parse({
        ...fields,
        id: this.newId(),
        workspaceId: actor.workspaceId,
        enabled: true,
        version: 1,
        authSecretId: null,
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      await tx.sources.insert(value);
      await this.audit(
        tx,
        actor,
        "signal.source.created",
        "signal_source",
        value.id,
      );
      return value;
    });
  }
  async update(actor: Actor, input: UpdateSignalSourceInput) {
    authorize(actor, true);
    const { id, expectedVersion, ...fields } =
      updateSignalSourceSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const current = await tx.sources.lock(id);
      if (!current) throw new PersistenceError("not_found");
      if (["probe", "heartbeat", "metrics"].includes(current.kind))
        throw new SignalManagementError("source_kind");
      if (current.version !== expectedVersion)
        throw new SignalManagementError("conflict");
      if (
        current.intake &&
        needsManualProviderRecovery(current.intake) &&
        fields.recovery !== "manual"
      )
        throw new SignalManagementError("invalid_configuration");
      const value = signalSourceSchema.parse({
        ...current,
        ...fields,
        version: expectedVersion + 1,
        updatedAt: tx.now,
      });
      if (!(await tx.sources.replace(value, expectedVersion)))
        throw new SignalManagementError("conflict");
      await this.audit(tx, actor, "signal.source.updated", "signal_source", id);
      return value;
    });
  }
  private async issueGrant(
    actor: Actor,
    input: IssueSignalTokenInput,
    receiver: boolean,
  ) {
    authorize(actor, true);
    const { sourceId, ttlSeconds } = issueSignalTokenSchema.parse(input);
    // Cryptographic entropy is generated once; plaintext is returned only after commit.
    const token = `esi_${randomBytes(32).toString("base64url")}`;
    const tokenHash = signalTokenDigest(token)!;
    const grant = await this.repository.transaction(
      actor.workspaceId,
      async (tx) => {
        const source = await tx.sources.lock(sourceId);
        if (!source) throw new PersistenceError("not_found");
        if (!source.enabled) throw new SignalManagementError("source_disabled");
        const signed = source.intake
          ? usesProviderSignature(source.intake)
          : false;
        const tokenSource =
          source.kind === "generic" ||
          source.intake?.mode === "glitchtip" ||
          source.intake?.mode === "grafana-bearer";
        if (receiver ? !signed : !tokenSource)
          throw new SignalManagementError("source_kind");
        const value = signalTokenSchema.parse({
          id: this.newId(),
          workspaceId: actor.workspaceId,
          sourceId,
          tokenHash,
          scope: "signal:write",
          createdAt: tx.now,
          revokedAt: null,
          expiresAt: new Date(
            Date.parse(tx.now) + ttlSeconds * 1000,
          ).toISOString(),
        });
        await tx.tokens.insert(value);
        await this.audit(
          tx,
          actor,
          receiver ? "signal.receiver.issued" : "signal.token.issued",
          "signal_token",
          value.id,
        );
        return { id: value.id, sourceId, expiresAt: value.expiresAt };
      },
    );
    return { grant, token };
  }
  async issueToken(actor: Actor, input: IssueSignalTokenInput) {
    const { grant, token } = await this.issueGrant(actor, input, false);
    return { ...grant, token };
  }
  /** Public routing reference; authentication still requires a valid provider MAC. */
  async issueReceiver(actor: Actor, input: IssueSignalTokenInput) {
    const { grant, token } = await this.issueGrant(actor, input, true);
    return { ...grant, receiverId: signalTokenDigest(token)! };
  }
  async revokeToken(actor: Actor, input: { id: string }) {
    authorize(actor, true);
    const { id } = signalSourceIdSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      if (!(await tx.tokens.revoke(id)))
        throw new PersistenceError("not_found");
      await this.audit(tx, actor, "signal.token.revoked", "signal_token", id);
      return { revoked: true as const };
    });
  }
  async createProvider(actor: Actor, input: CreateProviderSourceInput) {
    authorize(actor, true);
    const fields = createProviderSourceSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const source = signalSourceSchema.parse({
        ...fields,
        kind: providerSourceKind(fields.intake),
        recovery: needsManualProviderRecovery(fields.intake)
          ? "manual"
          : "explicit",
        id: this.newId(),
        workspaceId: actor.workspaceId,
        enabled: true,
        version: 1,
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      await tx.sources.insert(source);
      await this.audit(
        tx,
        actor,
        "signal.source.created",
        "signal_source",
        source.id,
      );
      return source;
    });
  }
  async updateProvider(actor: Actor, input: UpdateProviderSourceInput) {
    authorize(actor, true);
    const { id, expectedVersion, intake, authSecretId } =
      updateProviderSourceSchema.parse(input);
    return this.repository.transaction(actor.workspaceId, async (tx) => {
      const current = await tx.sources.lock(id);
      if (!current) throw new PersistenceError("not_found");
      if (current.version !== expectedVersion)
        throw new SignalManagementError("conflict");
      if (current.kind !== providerSourceKind(intake))
        throw new SignalManagementError("source_kind");
      const source = signalSourceSchema.parse({
        ...current,
        intake,
        authSecretId,
        recovery: needsManualProviderRecovery(intake)
          ? "manual"
          : current.recovery,
        version: expectedVersion + 1,
        updatedAt: tx.now,
      });
      if (!(await tx.sources.replace(source, expectedVersion)))
        throw new SignalManagementError("conflict");
      await this.audit(
        tx,
        actor,
        "signal.source.credentials.updated",
        "signal_source",
        id,
      );
      return source;
    });
  }
}
