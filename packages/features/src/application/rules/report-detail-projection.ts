import { z } from "zod";
import type { WorkspaceId } from "../../contracts/identity.js";
import {
  ruleReportDetailSchema,
  type RuleReportDetailInput,
} from "../../contracts/rule-report-detail.js";
const object = z.record(z.string(), z.unknown());
/** Hosts select at most limit+1 immutable rows. Full replay samples never leave storage. */
export function projectRuleReportDetail(
  scope: WorkspaceId,
  input: RuleReportDetailInput,
  raw: unknown,
) {
  const row = object.parse(raw),
    items = z
      .array(z.unknown())
      .max(input.limit + 1)
      .parse(row.items);
  const page = items.slice(0, input.limit).map((item) => {
    if (input.section !== "comparison") return item;
    const value = object.parse(item),
      observation = object.parse(value.observation),
      version = object.parse(observation.version),
      definition = object.parse(version.definition);
    return {
      ...value,
      observation: {
        ...observation,
        version: {
          ...version,
          definition: { ...definition, workspaceId: scope },
        },
      },
    };
  });
  return ruleReportDetailSchema.parse({
    workspaceId: scope,
    runId: input.runId,
    section: input.section,
    items: page,
    next: items.length > input.limit ? input.offset + page.length : null,
    ...(input.section === "comparison"
      ? { comparison: row.comparison ?? null }
      : {}),
  });
}
