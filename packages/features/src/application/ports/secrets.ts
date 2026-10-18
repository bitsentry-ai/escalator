import type { WorkspaceId } from "../../contracts/index.js";
import type { WorkQueue } from "../jobs/ports.js";

/** Host validates the persisted claim and approved bindings; caller payload is not authority. */
export interface SecretUse {
  workspaceId: WorkspaceId;
  secretId: string;
  queue: WorkQueue;
  workId: string;
  claimToken: string;
  signal: AbortSignal;
}
/** No Vault object names or resolved values may be serialized into work payloads. */
export interface SecretStore {
  withSecret<T>(
    request: SecretUse,
    consume: (bytes: Uint8Array) => Promise<T>,
  ): Promise<T>;
}
export class SecretAccessError extends Error {
  readonly code = "secret_unavailable";
  constructor() {
    super("Secret is unavailable for this operation");
    this.name = "SecretAccessError";
  }
}

/** Loaded from PostgreSQL by the host, never from a request body or LLM output. */
export interface PersistedSecretClaim {
  workspaceId: WorkspaceId;
  workId: string;
  queue: WorkQueue;
  state: string;
  token: string | null;
  expiresAt: string | null;
  databaseNow: string;
  approvedSecretIds: unknown;
}
export function assertSecretClaim(
  use: SecretUse,
  claim: PersistedSecretClaim,
): void {
  const now = Date.parse(claim.databaseNow);
  const expiry = Date.parse(claim.expiresAt ?? "");
  if (
    use.signal.aborted ||
    claim.workspaceId !== use.workspaceId ||
    claim.workId !== use.workId ||
    claim.queue !== use.queue ||
    claim.state !== "running" ||
    !use.claimToken ||
    claim.token !== use.claimToken ||
    !Number.isFinite(now) ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    !Array.isArray(claim.approvedSecretIds) ||
    !claim.approvedSecretIds.includes(use.secretId)
  ) {
    throw new SecretAccessError();
  }
}

/** Extract only from persisted work; hosts must still check scope, token and live expiry. */
export function approvedSecretIdsForWork(
  queue: WorkQueue,
  kind: string,
  payload: unknown,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return [];
  const data = payload as Record<string, unknown>;
  if (!kind.startsWith("paging.")) return data.secretIds;
  const expectedQueue =
    kind === "paging.send"
      ? "outbox"
      : ["paging.receipt", "paging.cancel"].includes(kind)
        ? "job"
        : undefined;
  if (
    queue !== expectedQueue ||
    "secretIds" in data ||
    typeof data.secretId !== "string" ||
    !Array.isArray(data.approvedSecretIds) ||
    data.approvedSecretIds.length !== 1 ||
    data.approvedSecretIds[0] !== data.secretId
  )
    return [];
  return data.approvedSecretIds;
}
