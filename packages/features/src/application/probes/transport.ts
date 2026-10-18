export interface ProbeRequest {
  url: string;
  method: "GET" | "HEAD" | "POST";
  headers: Readonly<Record<string, string>>;
  body: string | null;
  timeoutMs: number;
  maxResponseBytes: number;
}
export interface ProbeTransport {
  exchange(
    request: ProbeRequest,
    signal: AbortSignal,
  ): Promise<{ status: number; body: string }>;
}
export class ProbeTransportError extends Error {
  constructor(
    readonly reason:
      | "destination_denied"
      | "response_limit"
      | "network_error"
      | "timeout"
      | "cancelled"
      | "invalid_configuration",
  ) {
    super(reason);
  }
}
