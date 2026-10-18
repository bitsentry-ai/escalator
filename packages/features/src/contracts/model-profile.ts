import { z } from "zod";
import {
  opaqueIdSchema,
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "./identity.js";
import { modelDestinationSchema } from "./investigation.js";
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
