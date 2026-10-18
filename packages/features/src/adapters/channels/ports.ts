import type { SecretUse } from "../../application/ports/secrets.js";

/** Transport must bound requests/responses, pin validated DNS and reject redirects. */
export interface ChannelHttpTransport {
  send(request: {
    url: string;
    method: "GET" | "POST";
    headers: Readonly<Record<string, string>>;
    body?: string;
    signal: AbortSignal;
  }): Promise<{ status: number; body: string }>;
}
/** Transient data: acknowledgement URLs must never enter an outbox or audit payload. */
export interface ChannelNotification {
  deliveryId: string;
  title: string;
  message: string;
  acknowledgementUrl: string;
}
export type ChannelSendResult =
  | { outcome: "accepted"; receiptId: string | null }
  | { outcome: "unknown"; retryable: true }
  | {
      outcome: "rejected";
      retryable: boolean;
      reason:
        | "invalid_configuration"
        | "secret_unavailable"
        | "provider_rejected";
    };
export type ChannelReceiptResult =
  | { state: "pending" }
  | { state: "expired" }
  | { state: "acknowledged"; acknowledgedAt: string }
  | { state: "unknown" };
export interface NotificationChannel {
  send(
    notification: ChannelNotification,
    use: SecretUse,
  ): Promise<ChannelSendResult>;
}
export interface ReceiptChannel extends NotificationChannel {
  inspect(receiptId: string, use: SecretUse): Promise<ChannelReceiptResult>;
  /** Cancel every attempt for this delivery, including an accepted request whose response was lost. */
  cancel(deliveryId: string, use: SecretUse): Promise<"cancelled" | "unknown">;
}
