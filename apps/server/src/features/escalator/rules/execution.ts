import {
  generatePreparedRuleCandidate,
  SecretAccessError,
  type RuleProposalExecution,
} from "@bitsentry-escalator/features/application";
import {
  ruleProposalClaimSchema,
  ruleCandidateInputSchema,
} from "@bitsentry-escalator/features/contracts";
import {
  ScopedModelResolver,
  modelCredentialSecrets,
  type BoundedModelHttp,
} from "@bitsentry-escalator/features/investigation";
import type { PostgresRuleProposalModelAccess } from "../../../platform/database/rule-proposal-model-access.js";
import { EncryptedSecretStore } from "../../../platform/secrets/encrypted-secret.store.js";
import type { SecretKeyRing } from "../../../platform/secrets/keyring.js";
/** The model sees only the prepared context. Every profile/credential lookup
 * returns to the host's current claim-scoped authorization. */
export function standaloneRuleProposalExecution(
  access: Pick<PostgresRuleProposalModelAccess, "readProfile" | "readSecret">,
  keys: SecretKeyRing,
  transport: Pick<BoundedModelHttp, "bind">,
): RuleProposalExecution {
  return (raw, rawInput, signal) => {
    const claim = ruleProposalClaimSchema.parse(raw),
      input = ruleCandidateInputSchema.parse(rawInput);
    const expected = input.seedVersion.definition;
    if (expected.workspaceId !== claim.workspaceId)
      throw new SecretAccessError();
    const secrets = modelCredentialSecrets(
      new EncryptedSecretStore(keys, {
        load: async (request) => {
          if (
            request.signal.aborted ||
            request.queue !== "job" ||
            request.workspaceId !== claim.workspaceId ||
            request.workId !== claim.proposalId ||
            request.claimToken !== claim.token
          )
            throw new SecretAccessError();
          return access.readSecret(claim, request);
        },
      }),
    );
    const models = new ScopedModelResolver(
      {
        load: async (scope, id, context) => {
          context.signal.throwIfAborted();
          if (
            id !== input.profileId ||
            scope.workspaceId !== claim.workspaceId ||
            scope.serviceId !== expected.serviceId ||
            scope.environmentId !== expected.environmentId
          )
            return null;
          const profile = await access.readProfile(claim);
          context.signal.throwIfAborted();
          return profile ?? null;
        },
      },
      secrets,
      transport,
      { queue: "job", workId: claim.proposalId, claimToken: claim.token },
    );
    return generatePreparedRuleCandidate(input, models, signal);
  };
}
