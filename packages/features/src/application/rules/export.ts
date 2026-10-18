import { detectionRuleSchema } from "../../contracts/rules.js";
import {
  detectionRuleVersionSchema,
  type DetectionRuleVersion,
} from "../../contracts/rule-state.js";
import {
  ruleCatalogEntrySchema,
  type RuleCatalogEntry,
} from "../../contracts/rule-catalog.js";
import {
  portableRuleSchema,
  ruleImportMappingSchema,
  type PortableRule,
} from "../../contracts/portable-rule.js";
import type { Actor } from "../../contracts/identity.js";
import type { RuleDrafts } from "./catalog.js";
import { PersistenceError } from "../ports/persistence.js";
/** The management caller authorizes its catalog read; no host configuration or
 * secret reader is accepted by this projection. */
export function exportRule(
  rawEntry: RuleCatalogEntry,
  rawVersion: DetectionRuleVersion,
): PortableRule {
  const entry = ruleCatalogEntrySchema.parse(rawEntry),
    version = detectionRuleVersionSchema.parse(rawVersion),
    d = version.definition;
  if (
    version.id !== entry.id ||
    version.revision !== entry.versionRevision ||
    d.workspaceId !== entry.workspaceId ||
    d.serviceId !== entry.serviceId ||
    d.environmentId !== entry.environmentId
  )
    throw new PersistenceError("scope_violation");
  const selector =
    d.selector.kind === "metric"
      ? {
          kind: d.selector.kind,
          field: d.selector.field,
          minimumRequests: d.selector.minimumRequests,
        }
      : { kind: d.selector.kind, field: d.selector.field };
  return portableRuleSchema.parse({
    format: "escalator-rule",
    formatVersion: 1,
    title: entry.title,
    rule: {
      languageVersion: d.languageVersion,
      selector,
      aggregation: d.aggregation,
      windowSeconds: d.windowSeconds,
      stepSeconds: d.stepSeconds,
      collectionDelaySeconds: d.collectionDelaySeconds,
      minimumSamples: d.minimumSamples,
      trigger: d.trigger,
      recovery: d.recovery,
      persistenceSeconds: d.persistenceSeconds,
      recoverySeconds: d.recoverySeconds,
      cooldownSeconds: d.cooldownSeconds,
      severity: d.severity,
    },
  });
}
/** Local authorization, source locking and fresh draft identity remain owned by
 * RuleDrafts. Foreign activation state, approvals and AI report seals never travel. */
export function importRule(
  drafts: Pick<RuleDrafts, "create">,
  actor: Actor,
  raw: unknown,
  rawMapping: unknown,
) {
  const document = portableRuleSchema.parse(raw),
    mapping = ruleImportMappingSchema.parse(rawMapping);
  const definition = detectionRuleSchema.parse({
    ...document.rule,
    workspaceId: actor.workspaceId,
    serviceId: mapping.serviceId,
    environmentId: mapping.environmentId,
    selector: { ...document.rule.selector, streamId: mapping.streamId },
  });
  return drafts.create(actor, { title: document.title, definition });
}
