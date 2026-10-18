import { z } from "zod";
import { storableText, unicodeMessage } from "./text.js";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  responderIdSchema,
} from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { compareUtcTimestamps } from "./timestamps.js";
import { detectionRuleVersionSchema } from "./rule-state.js";
import { modelDestinationSchema } from "./investigation.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Internal model output: never an approved or activated rule. */
export const ruleCandidateResultSchema = z.strictObject({
  candidate: detectionRuleVersionSchema,
  rationale: z.string().max(1600).refine(storableText, unicodeMessage),
  destination: modelDestinationSchema,
  sourceSnapshotId: opaqueIdSchema,
  sourceInputHash: hash,
  trainingCutoffAt: utcTimestampSchema,
  usage: z.strictObject({
    modelCalls: z.literal(1),
    outputTokens: z.number().int().min(0).max(1024),
  }),
  reviewable: z.literal(false),
});
export type RuleCandidateResult = z.infer<typeof ruleCandidateResultSchema>;
export const ruleProposalSchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    requestedBy: responderIdSchema,
    originLabelId: opaqueIdSchema,
    sourceSnapshotId: opaqueIdSchema,
    sourceInputHash: hash,
    candidateId: opaqueIdSchema,
    profileId: opaqueIdSchema,
    profileRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    destination: modelDestinationSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    status: z.enum([
      "queued",
      "generating",
      "evaluating",
      "ready",
      "failed",
      "cancelled",
    ]),
    generation: ruleCandidateResultSchema.nullable(),
    failure: z
      .enum([
        "generation_failed",
        "evaluation_failed",
        "expired",
        "authorization_changed",
      ])
      .nullable(),
    fullRunId: opaqueIdSchema.nullable(),
    heldOutRunId: opaqueIdSchema.nullable(),
    heldOut: z.enum(["required", "insufficient_span"]),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
  })
  .superRefine((r, c) => {
    const invalid = (message: string) =>
      c.addIssue({ code: "custom", message });
    if (
      compareUtcTimestamps(r.updatedAt, r.createdAt) < 0 ||
      compareUtcTimestamps(r.expiresAt, r.createdAt) <= 0
    )
      invalid("Invalid proposal timestamps");
    if (Date.parse(r.expiresAt) - Date.parse(r.createdAt) > 86400000)
      invalid("Proposal lifetime exceeds one day");
    if (r.fullRunId && r.fullRunId === r.heldOutRunId)
      invalid("Evaluation runs must be distinct");
    if ((r.status === "failed") !== (r.failure !== null))
      invalid("Failure status mismatch");
    if (
      ["queued", "generating"].includes(r.status) &&
      (r.generation || r.fullRunId || r.heldOutRunId)
    )
      invalid("Unfinished generation has evaluation results");
    if (["evaluating", "ready"].includes(r.status) && !r.generation)
      invalid("Candidate required");
    if (
      r.generation &&
      (r.generation.candidate.id !== r.candidateId ||
        r.generation.candidate.revision !== 1 ||
        r.generation.candidate.definition.workspaceId !== r.workspaceId ||
        r.generation.sourceSnapshotId !== r.sourceSnapshotId ||
        r.generation.sourceInputHash !== r.sourceInputHash ||
        JSON.stringify(r.generation.destination) !==
          JSON.stringify(r.destination))
    )
      invalid("Candidate binding mismatch");
    if (r.heldOut === "insufficient_span" && r.heldOutRunId)
      invalid("Unexpected held-out evaluation");
    if (
      r.status === "ready" &&
      (!r.fullRunId || (r.heldOut === "required" && !r.heldOutRunId))
    )
      invalid("Reports required before review");
  });
export type RuleProposal = z.infer<typeof ruleProposalSchema>;
/** Request-body IDs are hints; only a matching live database claim authorizes work. */
export const ruleProposalClaimSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  proposalId: opaqueIdSchema,
  runtimeId: opaqueIdSchema,
  token: opaqueIdSchema,
  leaseExpiresAt: utcTimestampSchema,
  attempt: z.number().int().min(1).max(3),
});
export type RuleProposalClaim = z.infer<typeof ruleProposalClaimSchema>;
export const ruleProposalRequestSchema = z.strictObject({
  sourceSnapshotId: opaqueIdSchema,
  originLabelId: opaqueIdSchema,
  profileId: opaqueIdSchema,
});

export const ruleCandidateEvaluationSchema = z
  .strictObject({
    kind: z.literal("candidate"),
    sourceSnapshotId: opaqueIdSchema,
    sourceInputHash: hash,
    candidateHash: hash,
    firstDecisionAt: utcTimestampSchema,
    lastDecisionAt: utcTimestampSchema,
  })
  .refine(
    (x) => compareUtcTimestamps(x.firstDecisionAt, x.lastDecisionAt) <= 0,
    "Invalid candidate interval",
  );

export const ruleProposalEvaluationJobSchema = z.strictObject({
  proposalId: opaqueIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
