import type { SecretKeyRing } from "../../../platform/secrets/keyring.js";
import { EncryptedSecretStore } from "../../../platform/secrets/encrypted-secret.store.js";
import type { PostgresInvestigationRepository } from "../../../platform/database/postgres-investigation.repository.js";
import { SecretAccessError } from "@bitsentry-escalator/features/application";
import {
  investigationClaimSchema,
  ScopedModelResolver,
  modelCredentialSecrets,
  runInvestigation,
  type BoundedModelHttp,
  type InvestigationExecution,
} from "@bitsentry-escalator/features/investigation";
/** No runtime identity or source scope comes from model output or caller parameters. */
export type StandaloneInvestigationAccess = Pick<
  PostgresInvestigationRepository,
  "readModelSecret" | "readProfile" | "readNativeEvidence" | "trace"
>;
export function standaloneInvestigationExecution(
  repository: StandaloneInvestigationAccess,
  keys: SecretKeyRing,
  transport: Pick<BoundedModelHttp, "bind">,
): InvestigationExecution {
  return (input, signal) => {
    const claim = investigationClaimSchema.parse(input);
    const secrets = modelCredentialSecrets(
      new EncryptedSecretStore(keys, {
        load: async (request) => {
          if (
            request.signal.aborted ||
            request.queue !== "job" ||
            request.workspaceId !== claim.scope.workspaceId ||
            request.workId !== claim.id ||
            request.claimToken !== claim.claimToken
          )
            throw new SecretAccessError();
          return repository.readModelSecret(claim, request.secretId);
        },
      }),
    );
    const models = new ScopedModelResolver(
      {
        load: async (scope, id, context) => {
          context.signal.throwIfAborted();
          if (
            scope.workspaceId !== claim.scope.workspaceId ||
            scope.serviceId !== claim.scope.serviceId ||
            scope.environmentId !== claim.scope.environmentId ||
            id !== claim.profileId
          )
            return null;
          const profile = await repository.readProfile(claim);
          context.signal.throwIfAborted();
          return profile ?? null;
        },
      },
      secrets,
      transport,
      { queue: "job", workId: claim.id, claimToken: claim.claimToken },
    );
    return runInvestigation(
      claim,
      {
        models,
        trace: repository.trace,
        evidence: {
          read: async (scope, query, context) => {
            context.signal.throwIfAborted();
            if (
              scope.workspaceId !== claim.scope.workspaceId ||
              scope.serviceId !== claim.scope.serviceId ||
              scope.environmentId !== claim.scope.environmentId ||
              scope.incidentId !== claim.scope.incidentId
            )
              return {
                status: "unavailable",
                unavailable: { query, reason: "not_authorized" },
              };
            const result = await repository.readNativeEvidence(
              claim,
              query,
              context.maxBytes,
            );
            context.signal.throwIfAborted();
            return result;
          },
        },
      },
      signal,
    );
  };
}
