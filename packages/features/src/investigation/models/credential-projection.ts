import {
  modelKeyBundleSchema,
  createModelSecretSchema,
  type CreateModelSecretInput,
} from "../../contracts/model-secret.js";
import {
  SecretAccessError,
  type SecretStore,
} from "../../application/ports/secrets.js";
/** Writer owns and must erase the returned bytes. Never store a model key in profile JSON. */
export function encodeModelSecret(input: CreateModelSecretInput): Uint8Array {
  const value = createModelSecretSchema.parse(input);
  return new TextEncoder().encode(
    JSON.stringify({ token: value.credentials.key }),
  );
}
/** Model-only view of the host's approved secret callback. Source/channel formats are unchanged.
 * Host broker policy must independently approve this secret and destination for the live claim.
 */
export function modelCredentialSecrets(host: SecretStore): SecretStore {
  return {
    withSecret: (use, consume) =>
      host.withSecret(use, async (bytes) => {
        let key: Uint8Array | undefined;
        try {
          if (use.signal.aborted || bytes.byteLength > 16416)
            throw new SecretAccessError();
          const data = modelKeyBundleSchema.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          );
          key = new TextEncoder().encode(data.token);
          if (use.signal.aborted) throw new SecretAccessError();
          const result = await consume(key);
          if (use.signal.aborted) throw new SecretAccessError();
          return result;
        } catch {
          throw new SecretAccessError();
        } finally {
          key?.fill(0);
        }
      }),
  };
}
