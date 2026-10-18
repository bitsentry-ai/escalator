import {
  signalSourceSchema,
  signalTokenSchema,
  type WorkspaceId,
} from "../../contracts/index.js";
import { SecretAccessError } from "../ports/secrets.js";
/** Constructed after persisted receiver lookup, never copied from request JSON. */
export interface SourceVerificationUse {
  workspaceId: WorkspaceId;
  sourceId: string;
  sourceVersion: number;
  grantId: string;
  receiverHash: string;
  secretId: string;
  signal: AbortSignal;
}
/** Incoming signature verification is a separate permission from claimed jobs.
 * The host checks the live receiver, source version, secret ownership and
 * revocation before consuming plaintext; broker-backed hosts also recheck after
 * network I/O. Callbacks perform bounded, synchronous MAC verification/parsing.
 * Never return or retain plaintext, log it, or include it in a signal/job payload.
 */
export interface SourceVerificationSecrets {
  withSecret<T>(
    use: SourceVerificationUse,
    consume: (bytes: Uint8Array) => T,
  ): Promise<T>;
}

/** Persisted host rows, never a request-supplied authorization assertion. */
export interface SourceVerificationClaim {
  source: unknown;
  grant: unknown;
  databaseNow: string;
  serviceEnabled: boolean;
  secret: { id: string; workspaceId: string; enabled: boolean };
}
export function assertSourceVerificationClaim(
  use: SourceVerificationUse,
  claim: SourceVerificationClaim,
): void {
  const source = signalSourceSchema.safeParse(claim.source);
  const grant = signalTokenSchema.safeParse(claim.grant);
  const now = Date.parse(claim.databaseNow);
  if (
    use.signal.aborted ||
    !source.success ||
    !grant.success ||
    !Number.isFinite(now)
  )
    throw new SecretAccessError();
  const s = source.data;
  const g = grant.data;
  if (
    s.workspaceId !== use.workspaceId ||
    s.id !== use.sourceId ||
    s.version !== use.sourceVersion ||
    !s.enabled ||
    !claim.serviceEnabled ||
    (s.intake?.mode !== "sentry-hmac" && s.intake?.mode !== "grafana-hmac") ||
    s.authSecretId !== use.secretId ||
    g.workspaceId !== use.workspaceId ||
    g.id !== use.grantId ||
    g.sourceId !== s.id ||
    g.tokenHash !== use.receiverHash ||
    g.scope !== "signal:write" ||
    g.revokedAt !== null ||
    Date.parse(g.createdAt) > now ||
    Date.parse(g.expiresAt) <= now ||
    claim.secret.id !== use.secretId ||
    claim.secret.workspaceId !== use.workspaceId ||
    !claim.secret.enabled
  )
    throw new SecretAccessError();
}
