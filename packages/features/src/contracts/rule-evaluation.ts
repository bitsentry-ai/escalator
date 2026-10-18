import { z } from "zod";
import { opaqueIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { compareUtcTimestamps, hasSubmillisecondTime } from "./timestamps.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Immutable provenance. A held-out score is never a score on training data. */
export const ruleEvaluationSealSchema = z
  .strictObject({
    kind: z.literal("held_out"),
    strategy: z.literal("temporal-80-20-with-gap"),
    sourceSnapshotId: opaqueIdSchema,
    sourceInputHash: hash,
    candidateHash: hash,
    trainingCutoffAt: utcTimestampSchema,
    firstDecisionAt: utcTimestampSchema,
    lastDecisionAt: utcTimestampSchema,
    gapSeconds: z.literal(172800),
  })
  .refine(
    (s) =>
      [s.trainingCutoffAt, s.firstDecisionAt, s.lastDecisionAt].every(
        (at) => !hasSubmillisecondTime(at),
      ) &&
      Date.parse(s.firstDecisionAt) - Date.parse(s.trainingCutoffAt) >=
        172800000 &&
      compareUtcTimestamps(s.firstDecisionAt, s.lastDecisionAt) <= 0,
    "Invalid held-out seal range",
  );
export type RuleEvaluationSeal = z.infer<typeof ruleEvaluationSealSchema>;
