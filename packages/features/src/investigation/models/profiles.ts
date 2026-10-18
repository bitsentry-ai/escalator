import { z } from "zod";
import {
  modelDestinationSchema,
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "../../contracts/index.js";
import type { ModelScope, OperationContext } from "../ports/index.js";
export const modelProfileSchema = z
  .strictObject({
    id: opaqueIdSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    scope: z.strictObject({
      workspaceId: workspaceIdSchema,
      serviceId: serviceIdSchema,
      environmentId: environmentIdSchema,
    }),
    destination: modelDestinationSchema,
    endpoint: z.string().url().max(4096),
    secretId: opaqueIdSchema.nullable(),
  })
  .superRefine((profile, ctx) => {
    try {
      const url = new URL(profile.endpoint);
      if (
        url.origin !== profile.destination.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        ctx.addIssue({
          code: "custom",
          message: "Profile endpoint does not match its destination",
        });
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid model endpoint" });
    }
    if (profile.destination.provider !== "ollama" && profile.secretId === null)
      ctx.addIssue({
        code: "custom",
        message: "Hosted SDK profiles require an explicit secret binding",
      });
  });
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export interface ModelProfileReader {
  /** Host is bound to trusted work authorization. Validate the live claim and
   * service/environment profile binding on EVERY read, including secretless local models.
   * Return null for disabled, missing, unauthorized or no-longer-bound profiles.
   */
  load(
    scope: ModelScope,
    id: string,
    context: OperationContext,
  ): Promise<ModelProfile | null>;
}
