import { TRPCError } from "@trpc/server";
/** Explain actionable metric configuration failures without exposing deployment destinations. */
export async function metricRequest<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "destination_denied")
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Metric destination is not approved by the deployment administrator",
      });
    if (
      ["configured_limit", "active_limit", "request_budget"].includes(
        code ?? "",
      )
    )
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Metric capacity limit exceeded",
      });
    throw error;
  }
}
