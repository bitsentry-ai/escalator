import { RuleReportDetails } from "./RuleReportDetails.js";
import { RuleBacktestSummary } from "./RuleBacktestSummary.js";
import { useCallback, useEffect, useState } from "react";
import {
  captureRuleSchema,
  ruleResultsListSchema,
  type IncidentPageInput,
  type RuleCatalogView,
  type RuleReplayResult,
} from "../../contracts/index.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
import type { RulesProps } from "./types.js";
import { useRuleAction } from "./useRuleAction.js";
import { RuleProposals } from "./RuleProposals.js";
function utcInput(days: number) {
  return new Date(Math.floor(Date.now() / 60000) * 60000 - days * 86400000)
    .toISOString()
    .slice(0, 16);
}
export function RuleEvidence({
  client,
  scope,
  t,
  view,
  canPropose,
  selectedRun,
  onRun,
  onReviewRun,
  onChanged,
  onAdopt,
}: RulesProps & {
  view: RuleCatalogView;
  canPropose: boolean;
  selectedRun: string;
  onRun: (id: string) => void;
  onReviewRun: (id: string) => void;
  onChanged: () => void;
  onAdopt: (id: string) => void;
}) {
  const [first, setFirst] = useState(() => utcInput(30)),
    [last, setLast] = useState(() => utcInput(0)),
    [report, setReport] = useState<RuleReplayResult | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(false),
    [reload, setReload] = useState(0);
  const action = useRuleAction();
  const fetch = useCallback(
    (page: IncidentPageInput) =>
      client.replays(
        ruleResultsListSchema.parse({
          ...scope,
          ...page,
          ruleId: view.entry.id,
        }),
      ),
    [client, scope.serviceId, scope.environmentId, view.entry.id],
  );
  const runs = useIncidentCollection(fetch);
  useEffect(() => {
    let current = true;
    setReport(null);
    onReviewRun("");
    setError(false);
    setLoading(Boolean(selectedRun));
    if (!selectedRun) return;
    void client
      .replayResult({ id: selectedRun })
      .then((row) => {
        if (!current) return;
        if (!row) throw new Error("Replay unavailable");
        setReport(row);
        onReviewRun(
          row.version.id === view.entry.id &&
            row.report?.status === "BACKTESTED"
            ? row.id
            : "",
        );
      })
      .catch(() => {
        if (current) setError(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, selectedRun, reload, view.entry.id, onReviewRun]);
  return (
    <section>
      <h3>{t("rules.backtests")}</h3>
      {canPropose && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(
              () =>
                client.replay(
                  captureRuleSchema.parse({
                    ruleId: view.entry.id,
                    expectedRevision: view.entry.revision,
                    firstDecisionAt: new Date(first + "Z").toISOString(),
                    lastDecisionAt: new Date(last + "Z").toISOString(),
                  }),
                ),
              (row) => {
                runs.refresh();
                onRun(row.id);
              },
            );
          }}
        >
          <fieldset disabled={action.pending}>
            <label style={styles.label}>
              {t("rules.firstDecision")}
              <input
                type="datetime-local"
                required
                value={first}
                onChange={(e) => setFirst(e.target.value)}
              />
            </label>
            <label style={styles.label}>
              {t("rules.lastDecision")}
              <input
                type="datetime-local"
                required
                value={last}
                onChange={(e) => setLast(e.target.value)}
              />
            </label>
            <p>{t("rules.captureHelp")}</p>
            <button type="submit">{t("rules.capture")}</button>
          </fieldset>
        </form>
      )}
      <button
        type="button"
        onClick={() => {
          runs.refresh();
          setReload((n) => n + 1);
        }}
      >
        {t("sources.refresh")}
      </button>
      {(runs.loading || loading) && <p role="status">{t("sources.loading")}</p>}
      {(runs.error || error || action.error) && (
        <p role="alert">{t("rules.actionError")}</p>
      )}
      <ul>
        {runs.items.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              aria-pressed={selectedRun === run.id}
              onClick={() => onRun(run.id)}
            >
              {run.createdAt} · {t("rules.version")} {run.version.revision}
            </button>{" "}
            — {t(`rules.workStates.${run.state}`)}
          </li>
        ))}
      </ul>
      {runs.next && (
        <button
          type="button"
          disabled={runs.loading}
          onClick={() => void runs.more()}
        >
          {t("deployments.more")}
        </button>
      )}
      {report && <RuleBacktestSummary report={report} t={t} />}
      {report?.report && (
        <RuleReportDetails client={client} t={t} runId={report.id} />
      )}
      <RuleProposals
        client={client}
        scope={scope}
        t={t}
        capture={report}
        canPropose={canPropose}
        onChanged={onChanged}
        onRun={onRun}
        onAdopt={onAdopt}
      />
    </section>
  );
}
