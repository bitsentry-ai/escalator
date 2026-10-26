import { createHash } from "node:crypto";
import { z } from "zod";
import {
  signalInputSchema,
  opaqueIdSchema,
  utcTimestampSchema,
  type SignalInput,
} from "../../contracts/index.js";
import {
  parseSignalBody,
  SignalIngressError,
  signalTokenDigest,
} from "../../application/signals/ingest.js";
import { expectDefined } from "../../contracts/expect-defined.js";
const nativeAlert = z.object({
  text: z.string().max(4000),
  attachments: z
    .array(
      z.object({
        title_link: z.string().min(1).max(2048),
      }),
    )
    .min(1)
    .max(50),
});
export interface GlitchTipDelivery {
  /** Persisted host receipt identity, never an unsigned provider/request header. */
  deliveryId: string;
  /** Host database receipt time: native GlitchTip supplies no occurrence time. */
  receivedAt: string;
  /** Administrator-configured tracker origin. No URL is fetched by this adapter. */
  trackerOrigin: string;
}
/** Native GlitchTip is not a signed Sentry envelope. Call only after host token
 * authentication; deduplicating delivery receipts belongs to the host intake.
 * There is no native resolved event. Source recovery must be manual.
 */
export function normalizeGlitchTipAlert(
  body: Uint8Array,
  delivery: GlitchTipDelivery,
): SignalInput[] {
  const context = z
    .strictObject({
      deliveryId: opaqueIdSchema,
      receivedAt: utcTimestampSchema,
      trackerOrigin: z.string().max(2048),
    })
    .safeParse(delivery);
  if (!context.success) throw new SignalIngressError("invalid_input");
  const parsed = nativeAlert.safeParse(parseSignalBody(body));
  if (!parsed.success) throw new SignalIngressError("invalid_input");
  let origin: URL;
  try {
    origin = new URL(delivery.trackerOrigin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("Invalid tracker origin");
  } catch {
    throw new SignalIngressError("invalid_input");
  }
  const seen = new Set<string>();
  return parsed.data.attachments.flatMap((attachment) => {
    let link: URL;
    try {
      link = new URL(attachment.title_link);
      if (
        link.origin !== origin.origin ||
        link.username ||
        link.password ||
        link.search ||
        link.hash ||
        !/\/issues?\/\d{1,32}\/?$/.test(link.pathname)
      )
        throw new Error("Invalid issue link");
    } catch {
      throw new SignalIngressError("invalid_input");
    }
    // The link was checked against the same pattern above.
    const issueId = expectDefined(
      /\/issues?\/(\d{1,32})\/?$/.exec(link.pathname),
      "issue link match",
    )[1];
    const issue = createHash("sha256")
      .update(`${link.origin}${link.pathname.replace(/\/$/, "")}`)
      .digest("hex");
    if (seen.has(issue)) return [];
    seen.add(issue);
    const event = createHash("sha256")
      .update(JSON.stringify([delivery.deliveryId, issue]))
      .digest("hex");
    return [
      signalInputSchema.parse({
        version: 1,
        eventId: `glitchtip:${event}`,
        fingerprint: `glitchtip:issue:${issue}`,
        observedAt: delivery.receivedAt,
        status: "active",
        severity: "high",
        title: `GlitchTip issue ${issueId}`,
        evidence: {
          summary:
            "The error tracker reported an issue. Native notification time is unavailable; this observation uses receipt time.",
          attributes: [
            { name: "provider", value: "glitchtip" },
            { name: "time_basis", value: "received" },
            { name: "issue_key", value: issue },
            { name: "issue_id", value: issueId },
          ],
        },
      }),
    ];
  });
}

/** Extract a scoped grant for subsequent repository authorization. Never a session.
 * Native GlitchTip's HTTP client can send Basic credentials from its configured
 * webhook URL. Only the fixed username and canonical token encoding are allowed.
 */
export function glitchTipIngestionToken(
  authorization: string | undefined,
): string | undefined {
  const bearer = /^Bearer (esi_[A-Za-z0-9_-]{43})$/i.exec(authorization ?? "");
  if (bearer) return signalTokenDigest(bearer[1]) ? bearer[1] : undefined;
  const basic = /^Basic ([A-Za-z0-9+/]{1,124}={0,2})$/i.exec(
    authorization ?? "",
  );
  if (!basic) return undefined;
  const decoded = Buffer.from(basic[1], "base64");
  if (decoded.toString("base64") !== basic[1]) return undefined;
  const prefix = "escalator:";
  const value = decoded.toString("utf8");
  if (!value.startsWith(prefix)) return undefined;
  const token = value.slice(prefix.length);
  return signalTokenDigest(token) ? token : undefined;
}
