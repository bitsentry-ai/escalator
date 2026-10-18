import { modelKeyBundleSchema } from "@bitsentry-escalator/features/contracts";
import { SecretAccessError } from "@bitsentry-escalator/features/application";
import {
  investigationClaimSchema,
  type InvestigationClaim,
  type RepositoryEvidenceAccess,
} from "@bitsentry-escalator/features/investigation";
import type { PostgresInvestigationRepository } from "../../../platform/database/postgres-investigation.repository.js";
import { EncryptedSecretStore } from "../../../platform/secrets/encrypted-secret.store.js";
import type { SecretKeyRing } from "../../../platform/secrets/keyring.js";
export type StandaloneRepositoryAccess = Pick<
  PostgresInvestigationRepository,
  "readRepositoryEvidence"
>;
/** Bind repository access to one durable attempt. No model credential authorization is widened. */
export function standaloneRepositoryEvidenceAccess(
  repository: StandaloneRepositoryAccess,
  input: InvestigationClaim,
  keys: SecretKeyRing,
): RepositoryEvidenceAccess {
  const claim = investigationClaimSchema.parse(input);
  return {
    use: async (scope, query, context, operation) => {
      context.signal.throwIfAborted();
      if (
        Object.keys(claim.scope).some(
          (key) =>
            scope[key as keyof typeof scope] !==
            claim.scope[key as keyof typeof scope],
        )
      )
        return undefined;
      const before = await repository.readRepositoryEvidence(claim, query);
      context.signal.throwIfAborted();
      if (!before) return undefined;
      const record = before.secret;
      // The repository query has already committed. Neither decryption nor HTTP owns a DB connection.
      const result =
        record === null
          ? await operation(before.comparison, undefined)
          : await new EncryptedSecretStore(keys, {
              load: async () => record,
            }).withSecret(
              {
                workspaceId: claim.scope.workspaceId,
                workId: claim.id,
                queue: "job",
                claimToken: claim.claimToken,
                secretId: record.id,
                signal: context.signal,
              },
              async (bytes) => {
                if (bytes.byteLength > 16416) throw new SecretAccessError();
                // Reuse the stored bearer-bundle format, not the model-only secret reader.
                const bundle = modelKeyBundleSchema.parse(
                  JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                  ),
                );
                context.signal.throwIfAborted();
                return operation(before.comparison, bundle.token);
              },
            );
      context.signal.throwIfAborted();
      const after = await repository.readRepositoryEvidence(claim, query);
      context.signal.throwIfAborted();
      if (
        !after ||
        JSON.stringify(before.comparison) !==
          JSON.stringify(after.comparison) ||
        (before.secret === null) !== (after.secret === null) ||
        (before.secret !== null &&
          after.secret !== null &&
          (before.secret.id !== after.secret.id ||
            JSON.stringify(before.secret.envelope) !==
              JSON.stringify(after.secret.envelope)))
      )
        return undefined;
      return result;
    },
  };
}
