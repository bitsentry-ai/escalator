import { z } from "zod";
import { escalationPolicySchema } from "./escalation.js";
import { opaqueIdSchema, responderIdSchema } from "./identity.js";

/** Generated timeout routing is distinct from an operator's configured schedule ladder. */
export const deploymentPagePolicySchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: escalationPolicySchema.shape.workspaceId,
    serviceId: escalationPolicySchema.shape.serviceId,
    version: z.literal(1),
    deployment: z.strictObject({
      id: opaqueIdSchema,
      mappedDeployerId: responderIdSchema.nullable(),
      sourcePolicyId: opaqueIdSchema,
      sourcePolicyVersion: escalationPolicySchema.shape.version,
    }),
    fallbackResponderIds: escalationPolicySchema.shape.fallbackResponderIds,
    steps: z.tuple([
      z.strictObject({
        id: z.literal("deployer"),
        offsetMs: z.literal(0),
        target: z.literal("deployer"),
      }),
      z.strictObject({
        id: z.literal("service-fallback"),
        offsetMs: z.literal(120000),
        target: z.literal("fallback"),
      }),
    ]),
    terminal: escalationPolicySchema.shape.terminal,
  })
  .superRefine((value, ctx) => {
    for (const [name, ids] of [
      ["fallbackResponderIds", value.fallbackResponderIds],
      ["terminal.notifyResponderIds", value.terminal.notifyResponderIds],
    ] as const) {
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({
          code: "custom",
          message: "Recipients must be unique",
          path: name.split("."),
        });
    }
  });
export const pagePolicySchema = z.union([
  escalationPolicySchema,
  deploymentPagePolicySchema,
]);
export type PagePolicy = z.infer<typeof pagePolicySchema>;
export type DeploymentPagePolicy = z.infer<typeof deploymentPagePolicySchema>;
