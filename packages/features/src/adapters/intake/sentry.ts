import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  SIGNAL_INGRESS_MAX_BYTES,
  signalInputSchema,
  type SignalInput,
} from "../../contracts/index.js";
import {
  parseSignalBody,
  SignalIngressError,
} from "../../application/signals/ingest.js";

/** Verify the received bytes, never JSON reserialization or unsigned headers. */
export function verifySentrySignature(
  body: Uint8Array,
  signature: string | undefined,
  secret: Uint8Array,
): boolean {
  if (
    body.byteLength > SIGNAL_INGRESS_MAX_BYTES ||
    secret.byteLength === 0 ||
    secret.byteLength > 4096 ||
    !signature ||
    !/^[a-fA-F0-9]{64}$/.test(signature)
  )
    return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
const identifier = z
  .union([
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String);
const alert = z.object({
  action: z.literal("triggered"),
  data: z.object({
    event: z.object({
      event_id: z.string().regex(/^[a-fA-F0-9]{32}$/),
      issue_id: identifier,
      project: identifier,
      datetime: z.iso.datetime({ offset: true }),
      level: z.enum(["fatal", "error", "warning", "info", "debug", "log"]),
    }),
  }),
});
/** The host chooses the source after authentication; no payload field selects scope.
 * Issue alerts have no recovery event. Configure their source for manual recovery.
 * Exception values, request headers, user data and arbitrary tags are not retained.
 */
export function normalizeSentryIssueAlert(body: Uint8Array): SignalInput {
  const parsed = alert.safeParse(parseSignalBody(body));
  if (!parsed.success) throw new SignalIngressError("invalid_input");
  const event = parsed.data.data.event;
  const key = createHash("sha256")
    .update(JSON.stringify([event.project, event.issue_id]))
    .digest("hex");
  return signalInputSchema.parse({
    version: 1,
    eventId: `sentry:${event.event_id.toLowerCase()}`,
    fingerprint: `sentry:issue:${key}`,
    observedAt: new Date(event.datetime).toISOString(),
    status: "active",
    severity:
      event.level === "fatal"
        ? "critical"
        : event.level === "error"
          ? "high"
          : "warning",
    title: `Sentry issue ${event.issue_id}`,
    evidence: {
      summary:
        "An issue alert was triggered. Open the configured error tracker for detailed evidence.",
      attributes: [
        { name: "provider", value: "sentry" },
        { name: "project_id", value: event.project },
        { name: "issue_id", value: event.issue_id },
        { name: "event_id", value: event.event_id.toLowerCase() },
        { name: "level", value: event.level },
      ],
    },
  });
}

export function signedSentryIssueAlert(
  body: Uint8Array,
  signature: string | undefined,
  secret: Uint8Array,
): SignalInput {
  if (!verifySentrySignature(body, signature, secret))
    throw new SignalIngressError("invalid_token");
  return normalizeSentryIssueAlert(body);
}
