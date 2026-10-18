import { z } from "zod";
/** An administrator-selected origin; credentials and request data are never URL fields. */
export const trackerOriginSchema = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid origin");
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Expected a tracker origin without credentials, path or query",
      });
    }
  });
export const providerIntakeSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("sentry-hmac") }),
  z.strictObject({
    mode: z.literal("glitchtip"),
    trackerOrigin: trackerOriginSchema,
  }),
  z.strictObject({ mode: z.literal("grafana-bearer") }),
  z.strictObject({ mode: z.literal("grafana-hmac") }),
]);
export type ProviderIntake = z.infer<typeof providerIntakeSchema>;
export function providerSourceKind(
  intake: ProviderIntake,
): "sentry" | "glitchtip" | "grafana" {
  if (intake.mode === "sentry-hmac") return "sentry";
  return intake.mode === "glitchtip" ? "glitchtip" : "grafana";
}
export function usesProviderSignature(intake: ProviderIntake): boolean {
  return intake.mode === "sentry-hmac" || intake.mode === "grafana-hmac";
}
export function needsManualProviderRecovery(intake: ProviderIntake): boolean {
  return intake.mode === "sentry-hmac" || intake.mode === "glitchtip";
}
