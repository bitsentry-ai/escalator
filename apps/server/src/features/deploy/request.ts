import { TRPCError } from "@trpc/server";
export async function deploymentRequest<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "disabled")
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Deployment target or routing is disabled",
      });
    if (code === "invalid_responder")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Choose an enabled responder in this workspace",
      });
    throw error;
  }
}
