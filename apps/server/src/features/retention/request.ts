import { TRPCError } from "@trpc/server";
export async function retentionRequest<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "retention_busy")
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Retention maintenance is busy; retry shortly",
      });
    if (code === "capacity")
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Retention settings exceed the deployment limit",
      });
    if (error instanceof RangeError)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Coverage requires a valid historical window",
      });
    throw error;
  }
}
