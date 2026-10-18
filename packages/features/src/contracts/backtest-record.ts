import { z } from "zod";
import { opaqueIdSchema, workspaceIdSchema } from "./identity.js";
import { utcTimestampSchema } from "./entities.js";
import { ruleBacktestReportSchema } from "./rule-backtest.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ruleBacktestRecordSchema = z
  .strictObject({
    workspaceId: workspaceIdSchema,
    runId: opaqueIdSchema,
    snapshotId: opaqueIdSchema,
    inputHash: hash,
    labelHash: hash,
    createdAt: utcTimestampSchema,
    report: ruleBacktestReportSchema,
  })
  .refine(
    (r) =>
      r.workspaceId === r.report.rule.definition.workspaceId &&
      r.snapshotId === r.report.snapshotId,
    "Backtest report binding mismatch",
  );
export type RuleBacktestRecord = z.infer<typeof ruleBacktestRecordSchema>;
export const ruleBacktestJobSchema = z.strictObject({ runId: opaqueIdSchema });
