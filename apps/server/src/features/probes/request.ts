import { TRPCError } from "@trpc/server";
/** Explain actionable probe configuration failures without exposing deployment destinations. */
export async function probeRequest<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "destination_denied")
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Probe destination is not approved by the deployment administrator",
      });
    if (
      ["configured_limit", "active_limit", "request_budget"].includes(
        code ?? "",
      )
    )
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Probe capacity limit exceeded",
      });
    throw error;
  }
}
