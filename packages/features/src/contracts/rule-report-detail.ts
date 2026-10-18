import { z } from "zod";
import { opaqueIdSchema, workspaceIdSchema } from "./identity.js";
import {
  backtestEpisodeSchema,
  ruleBacktestReportSchema,
} from "./rule-backtest.js";
import { ruleComparisonSchema } from "./rule-comparison.js";
export const ruleReportDetailInputSchema = z.strictObject({
  runId: opaqueIdSchema,
  section: z.enum(["episodes", "gaps", "comparison"]),
  offset: z.number().int().min(0).max(44641).default(0),
  limit: z.number().int().min(1).max(25).default(10),
});
const identity = {
  workspaceId: workspaceIdSchema,
  runId: opaqueIdSchema,
  next: z.number().int().min(1).max(44641).nullable(),
};
export const ruleReportDetailSchema = z.discriminatedUnion("section", [
  z.strictObject({
    ...identity,
    section: z.literal("episodes"),
    items: z.array(backtestEpisodeSchema).max(25),
  }),
  z.strictObject({
    ...identity,
    section: z.literal("gaps"),
    items: z
      .array(ruleBacktestReportSchema.shape.availability.shape.gaps.element)
      .max(25),
  }),
  z
    .strictObject({
      ...identity,
      section: z.literal("comparison"),
      items: z.array(ruleComparisonSchema.shape.groups.element).max(25),
      comparison: ruleComparisonSchema.omit({ groups: true }).nullable(),
    })
    .refine(
      (row) => row.comparison !== null || row.items.length === 0,
      "Comparison metadata is missing",
    ),
]);
export type RuleReportDetailInput = z.infer<typeof ruleReportDetailInputSchema>;
export type RuleReportDetail = z.infer<typeof ruleReportDetailSchema>;
