import type { DetectionRule } from "../../contracts/index.js";
import type { RuleText } from "./types.js";
const operators = { gt: ">", gte: "≥", lt: "<", lte: "≤" } as const;
export function RuleDefinition({
  definition: d,
  t,
}: {
  definition: DetectionRule;
  t: RuleText;
}) {
  const numbers = [
    "windowSeconds",
    "stepSeconds",
    "collectionDelaySeconds",
    "minimumSamples",
    "persistenceSeconds",
    "recoverySeconds",
    "cooldownSeconds",
  ] as const;
  const rows: [string, string | number][] = [
    ["labels.kind", t(`labels.${d.selector.kind}`)],
    ["labels.source", d.selector.streamId],
    ["rules.field", t(`rules.fields.${d.selector.field}`)],
    ["rules.aggregation", t(`rules.aggregations.${d.aggregation}`)],
    ...numbers.map((key) => [`rules.${key}`, d[key]] as [string, number]),
    ["rules.trigger", `${operators[d.trigger.operator]} ${d.trigger.value}`],
    ["rules.recovery", `${operators[d.recovery.operator]} ${d.recovery.value}`],
    ["rules.severity", t(`rules.severities.${d.severity}`)],
  ];
  if (d.selector.kind === "metric")
    rows.push(["rules.minimumRequests", d.selector.minimumRequests]);
  return (
    <dl>
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{t(key)}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
