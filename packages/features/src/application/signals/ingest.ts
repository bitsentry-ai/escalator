import { recordSignal } from "./record.js";
import { createHash } from "node:crypto";
import {
  opaqueIdSchema,
  signalInputSchema,
  SIGNAL_INGRESS_MAX_BYTES,
} from "../../contracts/index.js";
import type { SignalRepository } from "./ports.js";

export class SignalIngressError extends Error {
  constructor(
    readonly code: "invalid_token" | "invalid_input" | "body_too_large",
  ) {
    super(code);
  }
}
/** Canonical 256-bit credential; the raw value never enters a repository. */
export function signalTokenDigest(token: string): string | undefined {
  if (!/^esi_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const bytes = Buffer.from(token.slice(4), "base64url");
  if (bytes.length !== 32 || `esi_${bytes.toString("base64url")}` !== token)
    return undefined;
  return createHash("sha256").update(token).digest("hex");
}
/** Hosts must also enforce the byte limit while streaming, before buffering. */
export function parseSignalBody(body: Uint8Array): unknown {
  if (body.byteLength > SIGNAL_INGRESS_MAX_BYTES)
    throw new SignalIngressError("body_too_large");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SignalIngressError("invalid_input");
  }
}
/** Generic token ingress. Provider signatures are verified by separate adapters. */
export class SignalIntake {
  constructor(private readonly repository: SignalRepository) {}

  async accept(
    sourceId: string,
    token: string,
    input: unknown,
  ): Promise<{ state: "accepted" | "duplicate"; signalId: string }> {
    const hash = signalTokenDigest(token);
    if (!hash || !opaqueIdSchema.safeParse(sourceId).success)
      throw new SignalIngressError("invalid_token");
    const context = await this.repository.findTokenContext(hash);
    if (!context || context.sourceId !== sourceId)
      throw new SignalIngressError("invalid_token");
    return this.repository.transaction(context.workspaceId, async (tx) => {
      // Source edits and grant revocation use this same lock ordering.
      const source = await tx.sources.get(sourceId);
      const grant = await tx.tokens.getByHash(hash);
      const now = Date.parse(await tx.currentTime());
      if (
        !source?.enabled ||
        source.kind !== "generic" ||
        !grant ||
        grant.id !== context.id ||
        grant.sourceId !== sourceId ||
        grant.scope !== "signal:write" ||
        grant.revokedAt !== null ||
        Date.parse(grant.expiresAt) <= now ||
        Date.parse(grant.createdAt) > now
      )
        throw new SignalIngressError("invalid_token");
      const service = await tx.services.get(source.serviceId);
      if (!service?.enabled) throw new SignalIngressError("invalid_token");
      const parsed = signalInputSchema.safeParse(input);
      if (!parsed.success) throw new SignalIngressError("invalid_input");
      return recordSignal(tx, source, grant.id, parsed.data);
    });
  }
}
