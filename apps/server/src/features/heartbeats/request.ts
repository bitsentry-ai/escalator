import { TRPCError } from "@trpc/server";
export async function heartbeatRequest<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if ((error as { code?: string })?.code === "invalid_expiry")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Heartbeat token expiry must be in the next 90 days",
      });
    throw error;
  }
}
