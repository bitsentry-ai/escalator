import {
  createMonitoringSecretSchema,
  type CreateMonitoringSecretInput,
} from "../../contracts/monitoring-credentials.js";
/** Caller owns and must zero this buffer. Signing adapters consume raw UTF-8 bytes, not JSON. */
export function encodeMonitoringSecret(
  input: CreateMonitoringSecretInput,
): Uint8Array {
  const value = createMonitoringSecretSchema.parse(input);
  return new TextEncoder().encode(
    value.kind === "provider-signing"
      ? value.credentials.key
      : JSON.stringify(value.credentials),
  );
}
