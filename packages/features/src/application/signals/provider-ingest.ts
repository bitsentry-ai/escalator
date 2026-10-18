import {
  signalInputSchema,
  type SignalSource,
  type SignalToken,
  type WorkspaceId,
} from "../../contracts/index.js";
import { signedSentryIssueAlert } from "../../adapters/intake/sentry.js";
import {
  normalizeGrafanaAlerts,
  signedGrafanaAlerts,
} from "../../adapters/intake/grafana-alerts.js";
import {
  glitchTipIngestionToken,
  normalizeGlitchTipAlert,
} from "../../adapters/intake/glitchtip.js";
import { SignalIngressError, signalTokenDigest } from "./ingest.js";
import { recordSignal } from "./record.js";
import type { SignalRepository, SignalTransaction } from "./ports.js";
import type { SourceVerificationSecrets } from "./source-secrets.js";
export type ProviderRoute =
  | "sentry"
  | "glitchtip"
  | "grafana"
  | "grafana-signed";
export interface ProviderDelivery {
  provider: ProviderRoute;
  /** A source ID for tokens, or public receiver digest for signed routes. */
  reference: string;
  authorization?: string;
  signature?: string;
  timestamp?: string;
  body: Uint8Array;
  signal: AbortSignal;
}
interface Prepared {
  workspaceId: WorkspaceId;
  source: SignalSource;
  grant: SignalToken;
  now: string;
}
const expectedMode = {
  sentry: "sentry-hmac",
  glitchtip: "glitchtip",
  grafana: "grafana-bearer",
  "grafana-signed": "grafana-hmac",
} as const;
/** Owns authentication and normalization; a caller cannot submit a "verified" JSON object. */
export class ProviderIntake {
  constructor(
    private readonly repository: SignalRepository,
    private readonly secrets: SourceVerificationSecrets | undefined,
    private readonly allowedWorkspace: (scope: WorkspaceId) => boolean,
    private readonly newId: () => string,
  ) {}
  private async authorized(
    tx: SignalTransaction,
    hash: string,
    context: { sourceId: string; id: string },
    request: ProviderDelivery,
  ): Promise<Prepared> {
    const source = await tx.sources.lock(context.sourceId);
    const grant = await tx.tokens.getByHash(hash);
    if (
      !this.allowedWorkspace(tx.workspaceId) ||
      !source?.enabled ||
      !grant ||
      grant.id !== context.id ||
      grant.sourceId !== source.id ||
      grant.scope !== "signal:write" ||
      grant.revokedAt !== null ||
      source.intake?.mode !== expectedMode[request.provider]
    )
      throw new SignalIngressError("invalid_token");
    if (!(await tx.services.get(source.serviceId))?.enabled)
      throw new SignalIngressError("invalid_token");
    if (
      source.authSecretId !== null &&
      !(await tx.sources.hasUsableSecret(source.id, source.version))
    )
      throw new SignalIngressError("invalid_token");
    const now = await tx.currentTime();
    if (
      Date.parse(grant.createdAt) > Date.parse(now) ||
      Date.parse(grant.expiresAt) <= Date.parse(now)
    )
      throw new SignalIngressError("invalid_token");
    return { workspaceId: tx.workspaceId, source, grant, now };
  }
  async accept(
    request: ProviderDelivery,
  ): Promise<{ state: "accepted" | "duplicate"; signalIds: string[] }> {
    request.signal.throwIfAborted();
    if (!Object.hasOwn(expectedMode, request.provider))
      throw new SignalIngressError("invalid_input");
    const signed =
      request.provider === "sentry" || request.provider === "grafana-signed";
    const token =
      request.provider === "glitchtip"
        ? glitchTipIngestionToken(request.authorization)
        : /^Bearer (esi_[A-Za-z0-9_-]{43})$/i.exec(
            request.authorization ?? "",
          )?.[1];
    const hash = signed
      ? /^[a-f0-9]{64}$/.test(request.reference)
        ? request.reference
        : undefined
      : token
        ? signalTokenDigest(token)
        : undefined;
    if (!hash) throw new SignalIngressError("invalid_token");
    const context = await this.repository.findTokenContext(hash);
    if (
      !context ||
      !this.allowedWorkspace(context.workspaceId) ||
      (!signed && context.sourceId !== request.reference)
    )
      throw new SignalIngressError("invalid_token");
    const prepared = await this.repository.transaction(
      context.workspaceId,
      (tx) => this.authorized(tx, hash, context, request),
    );
    const receiptId = this.newId();
    const normalized = signed
      ? await this.verifySigned(request, prepared, hash)
      : request.provider === "grafana"
        ? normalizeGrafanaAlerts(request.body)
        : normalizeGlitchTipAlert(request.body, {
            deliveryId: receiptId,
            receivedAt: prepared.now,
            trackerOrigin:
              prepared.source.intake?.mode === "glitchtip"
                ? prepared.source.intake.trackerOrigin
                : "",
          });
    request.signal.throwIfAborted();
    // No network or secret reads inside the acceptance transaction.
    return this.repository.transaction(context.workspaceId, async (tx) => {
      const current = await this.authorized(tx, hash, context, request);
      request.signal.throwIfAborted();
      // The MAC authenticated this timestamp; recheck freshness after secret I/O.
      if (
        request.provider === "grafana-signed" &&
        Math.abs(Date.parse(current.now) - Number(request.timestamp) * 1000) >
          300_000
      )
        throw new SignalIngressError("invalid_token");
      if (
        current.source.version !== prepared.source.version ||
        current.source.authSecretId !== prepared.source.authSecretId
      )
        throw new SignalIngressError("invalid_token");
      const results = [];
      for (const value of normalized) {
        const parsed = signalInputSchema.safeParse(value);
        if (!parsed.success) throw new SignalIngressError("invalid_input");
        results.push(
          await recordSignal(tx, current.source, current.grant.id, parsed.data),
        );
      }
      if (request.provider === "glitchtip") {
        await tx.audit.append({
          id: `signal.receipt:${receiptId}`,
          workspaceId: tx.workspaceId,
          actor: { kind: "system", component: "signal-ingress" },
          action: "signal.native.received",
          subjectType: "signal_source",
          subjectId: current.source.id,
          recordedAt: tx.now,
          metadata: { receiptId, signalCount: results.length },
        });
      }
      return {
        state: results.every((result) => result.state === "duplicate")
          ? "duplicate"
          : "accepted",
        signalIds: results.map((result) => result.signalId),
      };
    });
  }
  private async verifySigned(
    request: ProviderDelivery,
    prepared: Prepared,
    hash: string,
  ) {
    if (!this.secrets || !prepared.source.authSecretId)
      throw new Error("Source verification is unavailable");
    return this.secrets.withSecret(
      {
        workspaceId: prepared.workspaceId,
        sourceId: prepared.source.id,
        sourceVersion: prepared.source.version,
        grantId: prepared.grant.id,
        receiverHash: hash,
        secretId: prepared.source.authSecretId,
        signal: request.signal,
      },
      (bytes) =>
        request.provider === "sentry"
          ? [signedSentryIssueAlert(request.body, request.signature, bytes)]
          : signedGrafanaAlerts(
              request.body,
              request.signature,
              request.timestamp,
              bytes,
              Date.parse(prepared.now),
            ),
    );
  }
}
