import { useCallback, useState } from "react";
import {
  createRuleDraftSchema,
  investigationSourceOptionsInputSchema,
  type IncidentPageInput,
  type RuleCatalogView,
} from "../../contracts/index.js";
import { Choice } from "../labels/Choice.js";
import { styles } from "../incidents/styles.js";
import type { RulesProps } from "./types.js";
import { useRuleAction } from "./useRuleAction.js";
const numberFields = [
  "windowSeconds",
  "stepSeconds",
  "collectionDelaySeconds",
  "minimumSamples",
  "persistenceSeconds",
  "recoverySeconds",
  "cooldownSeconds",
] as const;
export function RuleEditor({
  client,
  scope,
  t,
  view,
  onSaved,
}: RulesProps & { view?: RuleCatalogView; onSaved: (id: string) => void }) {
  const d = view?.version.definition;
  const [title, setTitle] = useState(view?.entry.title ?? ""),
    [kind, setKind] = useState<"probe" | "metric" | "signal">(
      d?.selector.kind ?? "probe",
    ),
    [source, setSource] = useState(d?.selector.streamId ?? ""),
    [field, setField] = useState(d?.selector.field ?? "failure"),
    [aggregation, setAggregation] = useState(d?.aggregation ?? "maximum"),
    [severity, setSeverity] = useState(d?.severity ?? "high");
  const [trigger, setTrigger] = useState(String(d?.trigger.value ?? 1)),
    [recovery, setRecovery] = useState(String(d?.recovery.value ?? 0)),
    [triggerOperator, setTriggerOperator] = useState(
      d?.trigger.operator ?? "gte",
    ),
    [recoveryOperator, setRecoveryOperator] = useState(
      d?.recovery.operator ?? "lte",
    ),
    [minimumRequests, setMinimumRequests] = useState(
      String(d?.selector.kind === "metric" ? d.selector.minimumRequests : 1),
    );
  const [numbers, setNumbers] = useState<
    Record<(typeof numberFields)[number], string>
  >({
    windowSeconds: String(d?.windowSeconds ?? 60),
    stepSeconds: String(d?.stepSeconds ?? 60),
    collectionDelaySeconds: String(d?.collectionDelaySeconds ?? 0),
    minimumSamples: String(d?.minimumSamples ?? 1),
    persistenceSeconds: String(d?.persistenceSeconds ?? 0),
    recoverySeconds: String(d?.recoverySeconds ?? 0),
    cooldownSeconds: String(d?.cooldownSeconds ?? 0),
  });
  const action = useRuleAction();
  const sources = useCallback(
    async (page: IncidentPageInput) => {
      const result = await client.sources(
        investigationSourceOptionsInputSchema.parse({
          ...scope,
          ...page,
          kind: kind === "signal" ? "alert" : kind,
        }),
      );
      return {
        items: result.items.map((row) => ({
          id: row.sourceId,
          name: row.name,
          enabled: row.enabled,
        })),
        next: result.next,
      };
    },
    [client, scope.serviceId, scope.environmentId, kind],
  );
  function save() {
    void action.run(
      async () => {
        const input = createRuleDraftSchema.parse({
          title,
          definition: {
            ...scope,
            languageVersion: 1,
            selector: {
              kind,
              streamId: source,
              field,
              ...(kind === "metric"
                ? { minimumRequests: Number(minimumRequests) }
                : {}),
            },
            aggregation,
            severity,
            ...Object.fromEntries(
              numberFields.map((key) => [key, Number(numbers[key])]),
            ),
            trigger: { operator: triggerOperator, value: Number(trigger) },
            recovery: { operator: recoveryOperator, value: Number(recovery) },
          },
        });
        return view
          ? client.edit({
              ruleId: view.entry.id,
              expectedRevision: view.entry.revision,
              definition: input.definition,
            })
          : client.create(input);
      },
      (row) => onSaved(row.id),
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <fieldset disabled={action.pending}>
        <legend>{t(view ? "rules.edit" : "rules.new")}</legend>
        <label style={styles.label}>
          {t("rules.title")}
          <input
            required
            maxLength={240}
            value={title}
            readOnly={!!view}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label style={styles.label}>
          {t("labels.kind")}
          <select
            value={kind}
            disabled={!!view}
            onChange={(e) => {
              const next = e.target.value as typeof kind;
              setKind(next);
              setSource("");
              setField(
                next === "probe"
                  ? "failure"
                  : next === "metric"
                    ? "error_rate"
                    : "events",
              );
              setAggregation(next === "signal" ? "count" : "maximum");
            }}
          >
            {["probe", "metric", "signal"].map((value) => (
              <option key={value} value={value}>
                {t(`labels.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {view ? (
          <p>
            {t("labels.source")}: {source}
          </p>
        ) : (
          <Choice
            key={kind}
            fetch={sources}
            label={t("labels.source")}
            value={source}
            onChange={setSource}
            t={t}
          />
        )}
        <label style={styles.label}>
          {t("rules.field")}
          <select
            value={field}
            onChange={(e) => setField(e.target.value as typeof field)}
          >
            {(kind === "probe"
              ? ["failure", "duration_ms"]
              : kind === "metric"
                ? ["requests", "errors", "error_rate"]
                : ["events"]
            ).map((value) => (
              <option key={value} value={value}>
                {t(`rules.fields.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          {t("rules.aggregation")}
          <select
            value={aggregation}
            onChange={(e) =>
              setAggregation(e.target.value as typeof aggregation)
            }
          >
            {(kind === "signal"
              ? ["count"]
              : ["sum", "mean", "minimum", "maximum"]
            ).map((value) => (
              <option key={value} value={value}>
                {t(`rules.aggregations.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {numberFields.map((key) => (
          <label style={styles.label} key={key}>
            {t(`rules.${key}`)}
            <input
              type="number"
              required
              min={
                key === "windowSeconds" || key === "stepSeconds"
                  ? 60
                  : key === "minimumSamples"
                    ? 1
                    : 0
              }
              step={1}
              value={numbers[key]}
              onChange={(e) =>
                setNumbers({ ...numbers, [key]: e.target.value })
              }
            />
          </label>
        ))}
        {kind === "metric" && (
          <label style={styles.label}>
            {t("rules.minimumRequests")}
            <input
              type="number"
              required
              min={1}
              step={1}
              value={minimumRequests}
              onChange={(e) => setMinimumRequests(e.target.value)}
            />
          </label>
        )}
        <label style={styles.label}>
          {t("rules.trigger")}
          <select
            aria-label={t("rules.triggerOperator")}
            value={triggerOperator}
            onChange={(e) =>
              setTriggerOperator(e.target.value as typeof triggerOperator)
            }
          >
            <option value="gte">≥</option>
            <option value="gt">&gt;</option>
          </select>
          <input
            type="number"
            required
            min={0}
            step="any"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
          />
        </label>
        <label style={styles.label}>
          {t("rules.recovery")}
          <select
            aria-label={t("rules.recoveryOperator")}
            value={recoveryOperator}
            onChange={(e) =>
              setRecoveryOperator(e.target.value as typeof recoveryOperator)
            }
          >
            <option value="lte">≤</option>
            <option value="lt">&lt;</option>
          </select>
          <input
            type="number"
            required
            min={0}
            step="any"
            value={recovery}
            onChange={(e) => setRecovery(e.target.value)}
          />
        </label>
        <label style={styles.label}>
          {t("rules.severity")}
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as typeof severity)}
          >
            {["warning", "high", "critical"].map((value) => (
              <option key={value} value={value}>
                {t(`rules.severities.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <p>{t("rules.definitionHelp")}</p>
        <button type="submit" disabled={!source}>
          {t("rules.saveDraft")}
        </button>
      </fieldset>
      {action.error && <p role="alert">{t("rules.actionError")}</p>}
    </form>
  );
}
