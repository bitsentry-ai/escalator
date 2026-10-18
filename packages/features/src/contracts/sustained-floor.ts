import { z } from "zod";
export const sustainedFloorRuleSchema = z.strictObject({
  windowSeconds: z.number().int().min(120).max(86400),
  minimumSamples: z.number().int().min(2).max(1440),
  minimumRequests: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  errorRateFloor: z.number().gt(0).max(1),
});
export type SustainedFloorRule = z.infer<typeof sustainedFloorRuleSchema>;
export interface SustainedFloorVerdict {
  evaluatorVersion: 1;
  state: "active" | "clear" | "insufficient_data";
  reason:
    | "floor_met"
    | "below_floor"
    | "invalid_window"
    | "missing_samples"
    | "unusable_samples"
    | "insufficient_requests";
  sampleCount: number;
  requests: number | null;
  errors: number | null;
  minimumErrorRate: number | null;
}
