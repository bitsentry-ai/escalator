import { z } from "zod";
import { detectionRuleSchema, detectionRuleSelectorSchema } from "./rules.js";
import { ruleTitleSchema } from "./rule-catalog.js";
import {
  serviceIdSchema,
  environmentIdSchema,
  opaqueIdSchema,
} from "./identity.js";
const shape = detectionRuleSchema.shape;
const selectors = detectionRuleSelectorSchema.options;
/** Portable syntax carries evaluator parameters only. Import revalidates all
 * cross-field invariants after resolving the explicit local scope. */
export const portableRuleSchema = z.strictObject({
  format: z.literal("escalator-rule"),
  formatVersion: z.literal(1),
  title: ruleTitleSchema,
  rule: z.strictObject({
    languageVersion: shape.languageVersion,
    selector: z.discriminatedUnion("kind", [
      selectors[0].omit({ streamId: true }),
      selectors[1].omit({ streamId: true }),
      selectors[2].omit({ streamId: true }),
    ]),
    aggregation: shape.aggregation,
    windowSeconds: shape.windowSeconds,
    stepSeconds: shape.stepSeconds,
    collectionDelaySeconds: shape.collectionDelaySeconds,
    minimumSamples: shape.minimumSamples,
    trigger: shape.trigger,
    recovery: shape.recovery,
    persistenceSeconds: shape.persistenceSeconds,
    recoverySeconds: shape.recoverySeconds,
    cooldownSeconds: shape.cooldownSeconds,
    severity: shape.severity,
  }),
});
export const ruleImportMappingSchema = z.strictObject({
  serviceId: serviceIdSchema,
  environmentId: environmentIdSchema,
  streamId: opaqueIdSchema,
});
export type PortableRule = z.infer<typeof portableRuleSchema>;
export type RuleImportMapping = z.infer<typeof ruleImportMappingSchema>;
