import {
  authorizeRuleProposalModel,
  type SecretUse,
} from "@bitsentry-escalator/features/application";
import {
  ruleProposalClaimSchema,
  opaqueIdSchema,
  type RuleProposalClaim,
  type ModelProfile,
} from "@bitsentry-escalator/features/contracts";
import type { SecretEnvelope } from "../secrets/keyring.js";
import type { EncryptedSecretReader } from "../secrets/encrypted-secret.store.js";
import type { PostgresRuleProposalRepository } from "./rule-proposal.repository.js";
/** Only this standalone adapter can return an encrypted envelope. Plaintext is
 * opened after the fenced transaction by the existing EncryptedSecretStore. */
export class PostgresRuleProposalModelAccess {
  constructor(
    private readonly repository: Pick<
      PostgresRuleProposalRepository,
      "transaction" | "withConnection"
    >,
  ) {}
  readProfile(raw: RuleProposalClaim): Promise<ModelProfile | undefined> {
    const claim = ruleProposalClaimSchema.parse(raw);
    return this.repository.transaction(claim.workspaceId, (tx) =>
      authorizeRuleProposalModel(tx, claim),
    );
  }
  readSecret(
    raw: RuleProposalClaim,
    request: SecretUse,
  ): ReturnType<EncryptedSecretReader["load"]> {
    const claim = ruleProposalClaimSchema.parse(raw);
    opaqueIdSchema.parse(request.secretId);
    if (
      request.signal.aborted ||
      request.workspaceId !== claim.workspaceId ||
      request.queue !== "job" ||
      request.workId !== claim.proposalId ||
      request.claimToken !== claim.token
    )
      return Promise.resolve(undefined);
    return this.repository.withConnection(claim.workspaceId, async (tx, db) => {
      const profile = await authorizeRuleProposalModel(tx, claim);
      if (!profile || profile.secretId !== request.secretId) return undefined;
      const result = await db.query<{
        envelope: SecretEnvelope;
        lease_expires_at: Date;
        database_now: Date;
      }>(
        `SELECT s.envelope,j.lease_expires_at,clock_timestamp() AS database_now
        FROM escalator_secret s JOIN escalator_job j ON j.workspace_id=s.workspace_id AND j.id=$3
        WHERE s.workspace_id=$1 AND s.id=$2 AND s.purpose='provider' AND s.disabled_at IS NULL
        AND j.kind='rules.propose' AND j.state='running' AND j.lease_token=$4 AND j.attempt_count=$5
        AND j.lease_expires_at>clock_timestamp() FOR SHARE OF s`,
        [
          claim.workspaceId,
          request.secretId,
          claim.proposalId,
          claim.token,
          claim.attempt,
        ],
      );
      const row = result.rows[0];
      if (
        !row ||
        request.signal.aborted ||
        JSON.stringify(await authorizeRuleProposalModel(tx, claim)) !==
          JSON.stringify(profile)
      )
        return undefined;
      return {
        id: request.secretId,
        workspaceId: claim.workspaceId,
        disabled: false,
        envelope: row.envelope,
        claim: {
          workspaceId: claim.workspaceId,
          workId: claim.proposalId,
          queue: "job" as const,
          state: "running",
          token: claim.token,
          expiresAt: row.lease_expires_at.toISOString(),
          databaseNow: row.database_now.toISOString(),
          approvedSecretIds: [request.secretId],
        },
      };
    });
  }
}
