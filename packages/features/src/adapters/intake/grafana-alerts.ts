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
function grafanaSeverity(level: unknown): "critical" | "warning" | "high" {
  if (level === "critical") return "critical";
  if (level === "warning") return "warning";
  return "high";
}
/** Configure a timestamp header in Grafana. Its exact bytes are part of the MAC. */
export function verifyGrafanaSignature(
  body: Uint8Array,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: Uint8Array,
  nowMilliseconds: number,
): boolean {
  if (
    body.byteLength > SIGNAL_INGRESS_MAX_BYTES ||
    !signature ||
    !/^[a-fA-F0-9]{64}$/.test(signature) ||
    !timestamp ||
    !/^[1-9][0-9]{9,10}$/.test(timestamp) ||
    !Number.isFinite(nowMilliseconds) ||
    secret.byteLength === 0 ||
    secret.byteLength > 4096
  )
    return false;
  const observed = Number(timestamp) * 1000;
  if (Math.abs(nowMilliseconds - observed) > 300_000) return false;
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}:`)
    .update(body)
    .digest();
  return timingSafeEqual(digest, Buffer.from(signature, "hex"));
}
const notification = z.object({
  version: z.literal("1"),
  status: z.enum(["firing", "resolved"]),
  truncatedAlerts: z.literal(0),
  alerts: z
    .array(
      z.object({
        status: z.enum(["firing", "resolved"]),
        fingerprint: z.string().regex(/^[a-fA-F0-9]{16,64}$/),
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }),
        labels: z
          .object({ severity: z.string().max(64).optional() })
          .optional(),
      }),
    )
    .min(1)
    .max(100),
});
/** Normalize each alert, not the group's summary status. Missing alerts are not recovery. */
export function normalizeGrafanaAlerts(body: Uint8Array): SignalInput[] {
  const parsed = notification.safeParse(parseSignalBody(body));
  if (!parsed.success) throw new SignalIngressError("invalid_input");
  const events = new Map<string, SignalInput>();
  for (const alert of parsed.data.alerts) {
    const start = new Date(alert.startsAt).toISOString();
    const end = new Date(alert.endsAt).toISOString();
    if (
      Date.parse(start) < 0 ||
      (alert.status === "resolved" && Date.parse(end) < Date.parse(start))
    )
      throw new SignalIngressError("invalid_input");
    const status = alert.status === "firing" ? "active" : "recovered";
    const fingerprint = `grafana:${alert.fingerprint.toLowerCase()}`;
    const observedAt = status === "active" ? start : end;
    const id = createHash("sha256")
      .update(JSON.stringify([fingerprint, start, status, observedAt]))
      .digest("hex");
    const level = alert.labels?.severity?.toLowerCase();
    events.set(
      id,
      signalInputSchema.parse({
        version: 1,
        eventId: `grafana:${id}`,
        fingerprint,
        observedAt,
        status,
        severity: grafanaSeverity(level),
        title: "Grafana alert",
        evidence: {
          summary:
            status === "active"
              ? "Grafana reported a firing alert."
              : "Grafana explicitly reported this alert as resolved.",
          attributes: [
            { name: "provider", value: "grafana" },
            { name: "occurrence_started_at", value: start },
          ],
        },
      }),
    );
  }
  return [...events.values()];
}

export function signedGrafanaAlerts(
  body: Uint8Array,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: Uint8Array,
  nowMilliseconds: number,
): SignalInput[] {
  if (
    !verifyGrafanaSignature(body, signature, timestamp, secret, nowMilliseconds)
  )
    throw new SignalIngressError("invalid_token");
  return normalizeGrafanaAlerts(body);
}
