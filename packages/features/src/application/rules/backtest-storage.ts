import {
  ruleBacktestRecordSchema,
  type WorkspaceId,
  type RuleBacktestRecord,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
export function encodeRuleBacktest(
  scope: WorkspaceId,
  raw: RuleBacktestRecord,
): string {
  const row = ruleBacktestRecordSchema.parse(raw);
  if (row.workspaceId !== scope) throw new PersistenceError("scope_violation");
  const data = JSON.stringify(row, (key, value: unknown) =>
    key === "workspaceId" ? undefined : value,
  );
  if (new TextEncoder().encode(data).byteLength > 16777216)
    throw new RangeError("Backtest report storage limit exceeded");
  return data;
}
export function decodeRuleBacktest(
  scope: WorkspaceId,
  raw: unknown,
): RuleBacktestRecord {
  const r = raw as RuleBacktestRecord;
  return ruleBacktestRecordSchema.parse({
    ...r,
    workspaceId: scope,
    report: {
      ...r.report,
      comparison: r.report.comparison
        ? {
            ...r.report.comparison,
            groups: r.report.comparison.groups.map((g) => ({
              ...g,
              observation: {
                ...g.observation,
                version: {
                  ...g.observation.version,
                  definition: {
                    ...g.observation.version.definition,
                    workspaceId: scope,
                  },
                },
              },
            })),
          }
        : null,
      rule: {
        ...r.report.rule,
        definition: { ...r.report.rule.definition, workspaceId: scope },
      },
    },
  });
}
