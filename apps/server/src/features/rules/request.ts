import { TRPCError } from "@trpc/server";
import { ruleRequestFailure } from "@bitsentry-escalator/features/application";
export async function ruleRequest<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const failure = ruleRequestFailure(error);
    if (failure) throw new TRPCError(failure);
    throw error;
  }
}
