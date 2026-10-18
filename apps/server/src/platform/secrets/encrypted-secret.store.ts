import {
  SecretAccessError,
  assertSecretClaim,
  type SecretStore,
  type SecretUse,
  type PersistedSecretClaim,
} from "@bitsentry-escalator/features/application";
import { SecretKeyRing, type SecretEnvelope } from "./keyring.js";

export interface EncryptedSecretReader {
  /** Same scoped read supplies the active work claim and its approved secret IDs. */
  load(request: SecretUse): Promise<
    | {
        id: string;
        workspaceId: string;
        disabled: boolean;
        envelope: SecretEnvelope;
        claim: PersistedSecretClaim;
      }
    | undefined
  >;
}
/** Only authorized, current durable attempts can release bytes to trusted adapters. */
export class EncryptedSecretStore implements SecretStore {
  constructor(
    private readonly keys: SecretKeyRing,
    private readonly reader: EncryptedSecretReader,
  ) {}
  async withSecret<T>(
    request: SecretUse,
    consume: (bytes: Uint8Array) => Promise<T>,
  ): Promise<T> {
    let bytes: Buffer | undefined;
    try {
      if (request.signal.aborted) throw new SecretAccessError();
      const record = await this.reader.load(request);
      if (
        !record ||
        record.disabled ||
        record.id !== request.secretId ||
        record.workspaceId !== request.workspaceId
      )
        throw new SecretAccessError();
      assertSecretClaim(request, record.claim);
      bytes = this.keys.open(
        { id: record.id, workspaceId: record.workspaceId },
        record.envelope,
      );
      request.signal.throwIfAborted();
      return await consume(bytes);
    } catch {
      // Neither malformed stored data nor callback/provider errors may expose values.
      throw new SecretAccessError();
    } finally {
      // Best effort for this owned buffer; JavaScript/SDK copies cannot be guaranteed erased.
      bytes?.fill(0);
    }
  }
}
