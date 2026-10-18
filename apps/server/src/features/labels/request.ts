import { TRPCError } from "@trpc/server";
/** Convert new label errors without exposing validation payloads or database details. */
export async function labelRequest<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const value = error as { name?: string; code?: string } | undefined;
    if (value?.name === "ZodError")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Invalid incident label",
      });
    if (value?.code === "immutable")
      throw new TRPCError({
        code: "CONFLICT",
        message: "This label was reviewed; reload before continuing",
      });
    throw error;
  }
}
