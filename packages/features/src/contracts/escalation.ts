import { z } from "zod";
import {
  opaqueIdSchema,
  responderIdSchema,
  serviceIdSchema,
  workspaceIdSchema,
} from "./identity.js";
import { scheduleIdSchema } from "./schedule.js";
export const escalationTargetSchema = z.enum(["primary", "peer", "fallback"]);
export const escalationPolicySchema = z
  .strictObject({
    id: opaqueIdSchema,
    workspaceId: workspaceIdSchema,
    serviceId: serviceIdSchema,
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    primaryScheduleId: scheduleIdSchema,
    peerScheduleId: scheduleIdSchema,
    fallbackResponderIds: z.array(responderIdSchema).min(1).max(100),
    steps: z
      .array(
        z.strictObject({
          id: opaqueIdSchema,
          offsetMs: z
            .number()
            .int()
            .min(0)
            .max(7 * 86_400_000),
          target: escalationTargetSchema,
        }),
      )
      .min(1)
      .max(20),
    terminal: z.strictObject({
      reminderIntervalMs: z.number().int().min(60_000).max(86_400_000),
      maxReminders: z.number().int().min(1).max(100),
      action: z.literal("notify_operator"),
      notifyResponderIds: z.array(responderIdSchema).min(1).max(100),
    }),
  })
  .superRefine((policy, ctx) => {
    if (
      policy.steps[0]!.offsetMs !== 0 ||
      policy.steps.some(
        (step, i) => i > 0 && step.offsetMs <= policy.steps[i - 1]!.offsetMs,
      ) ||
      new Set(policy.steps.map((step) => step.id)).size !==
        policy.steps.length ||
      policy.steps.some(
        (step) => step.id.startsWith("reminder:") || step.id === "terminal",
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Steps must start at zero with unique IDs and increasing offsets",
        path: ["steps"],
      });
    for (const [name, ids] of [
      ["fallbackResponderIds", policy.fallbackResponderIds],
      ["terminal.notifyResponderIds", policy.terminal.notifyResponderIds],
    ] as const)
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({
          code: "custom",
          message: "Recipients must be unique",
          path: name.split("."),
        });
  });
export type EscalationPolicy = z.infer<typeof escalationPolicySchema>;
export type EscalationTarget = z.infer<typeof escalationTargetSchema>;
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export type PolicySnapshot = DeepReadonly<EscalationPolicy>;
export interface EscalationStep {
  id: string;
  dueAt: string;
  target: EscalationTarget | "operator";
}
export type EscalationDecision =
  | { kind: "cancel"; cancel: string[]; exhausted: boolean }
  | { kind: "wait"; dueAt: string | null; skip: string[]; exhausted: boolean }
  | {
      kind: "dispatch";
      step: EscalationStep;
      skip: string[];
      nextDueAt: string | null;
      exhausted: boolean;
    };
