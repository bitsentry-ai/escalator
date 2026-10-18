import { createHash } from "node:crypto";
import { z } from "zod";
import {
  httpProbeConfigSchema,
  type HttpProbeConfig,
  type ProbeResult,
} from "../../contracts/probes.js";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  type WorkspaceId,
} from "../../contracts/identity.js";
import {
  evaluateProbeResponse,
  validateSyntheticProbe,
} from "../../domain/probes/assertions.js";
import type { SecretStore } from "../ports/secrets.js";
import { ProbeTransportError, type ProbeTransport } from "./transport.js";
export type ProbeObservation = Pick<
  ProbeResult,
  "outcome" | "reason" | "statusCode" | "durationMs"
>;
export interface ProbeExecution {
  workspaceId: WorkspaceId;
  workId: string;
  claimToken: string;
  signal: AbortSignal;
}
const credentialSchema = z.strictObject({
  header: z.enum(["authorization", "x-api-key"]),
  value: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x20-\x7e]+$/),
});
/** The job use case supplies persisted configuration and a fenced claim; plaintext never enters results. */
export class HttpProbeRunner {
  constructor(
    private readonly transport: ProbeTransport,
    private readonly secrets?: SecretStore,
    private readonly now = () => performance.now(),
  ) {}
  async run(
    input: HttpProbeConfig,
    use: ProbeExecution,
  ): Promise<ProbeObservation> {
    const started = this.now();
    const result = (
      outcome: ProbeObservation["outcome"],
      reason: ProbeObservation["reason"],
      statusCode: number | null = null,
    ): ProbeObservation => ({
      outcome,
      reason,
      statusCode,
      durationMs: Math.min(
        60000,
        Math.max(0, Math.round(this.now() - started)),
      ),
    });
    if (use.signal.aborted) return result("unknown", "cancelled");
    let config: HttpProbeConfig;
    try {
      config = httpProbeConfigSchema.parse(input);
      workspaceIdSchema.parse(use.workspaceId);
      opaqueIdSchema.parse(use.workId);
      validateSyntheticProbe(config);
    } catch {
      return result("unknown", "invalid_configuration");
    }
    const headers: Record<string, string> = { accept: "*/*" };
    if (config.syntheticWrite) {
      headers["content-type"] = "application/json";
      headers[config.syntheticWrite.idempotencyHeader] = createHash("sha256")
        .update(JSON.stringify([use.workspaceId, use.workId]))
        .digest("hex");
    }
    const send = async (): Promise<ProbeObservation> => {
      try {
        const response = await this.transport.exchange(
          {
            url: config.url,
            method: config.method,
            headers,
            body: config.body,
            timeoutMs: config.timeoutMs,
            maxResponseBytes: config.maxResponseBytes,
          },
          use.signal,
        );
        const verdict = evaluateProbeResponse(
          config,
          response.status,
          response.body,
        );
        return result(verdict.outcome, verdict.reason, response.status);
      } catch (error) {
        if (use.signal.aborted) return result("unknown", "cancelled");
        const reason =
          error instanceof ProbeTransportError ? error.reason : "network_error";
        return result(
          ["network_error", "timeout"].includes(reason) ? "failed" : "unknown",
          reason,
        );
      }
    };
    if (!config.authSecretId) return send();
    if (new URL(config.url).protocol !== "https:")
      return result("unknown", "destination_denied");
    if (!this.secrets) return result("unknown", "secret_unavailable");
    try {
      return await this.secrets.withSecret(
        {
          workspaceId: use.workspaceId,
          secretId: config.authSecretId,
          queue: "job",
          workId: use.workId,
          claimToken: use.claimToken,
          signal: use.signal,
        },
        async (bytes) => {
          if (bytes.length > 16384) throw new Error("Invalid probe credential");
          const credential = credentialSchema.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          );
          headers[credential.header] = credential.value;
          try {
            return await send();
          } finally {
            delete headers[credential.header];
          }
        },
      );
    } catch {
      return result(
        "unknown",
        use.signal.aborted ? "cancelled" : "secret_unavailable",
      );
    }
  }
}
