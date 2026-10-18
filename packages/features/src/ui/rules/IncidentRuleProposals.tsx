import { useCallback, useEffect, useState } from "react";
import {
  incidentLabelsQuerySchema,
  ruleProposalsListSchema,
  type IncidentPageInput,
  type OperationalIncident,
  type RuleReplayResult,
} from "../../contracts/index.js";
import { Choice } from "../labels/Choice.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import { ProposalCard } from "./RuleProposals.js";
import { RuleBacktestSummary } from "./RuleBacktestSummary.js";
import { RuleReportDetails } from "./RuleReportDetails.js";
import type { RulesClient } from "./client.js";
import type { RuleText, RulesProps } from "./types.js";
/** Read-only incident context; adoption and activation remain explicit Rules actions. */
export function IncidentRuleProposals({
  client,
  incident,
  t,
}: {
  client: RulesClient;
  incident: OperationalIncident;
  t: RuleText;
}) {
  const [label, setLabel] = useState("");
  const fetch = useCallback(
    async (page: IncidentPageInput) => {
      const result = await client.labels(
        incidentLabelsQuerySchema.parse({
          ...page,
          serviceId: incident.serviceId,
          environmentId: incident.environmentId,
          incidentId: incident.id,
        }),
      );
      return {
        items: result.items.map((row) => ({
          id: row.id,
          name: row.summary.slice(0, 100),
        })),
        next: result.next,
      };
    },
    [client, incident.id, incident.serviceId, incident.environmentId],
  );
  return (
    <section>
      <h3>{t("rules.proposals")}</h3>
      <Choice
        fetch={fetch}
        label={t("rules.originLabel")}
        value={label}
        onChange={setLabel}
        t={t}
      />
      {label && (
        <LinkedProposals
          key={`${incident.id}:${label}`}
          client={client}
          t={t}
          scope={{
            serviceId: incident.serviceId,
            environmentId: incident.environmentId,
          }}
          labelId={label}
        />
      )}
    </section>
  );
}
function LinkedProposals({
  client,
  t,
  scope,
  labelId,
}: RulesProps & { labelId: string }) {
  const fetch = useCallback(
    (page: IncidentPageInput) =>
      client.proposals(
        ruleProposalsListSchema.parse({
          ...scope,
          ...page,
          originLabelId: labelId,
        }),
      ),
    [client, scope.serviceId, scope.environmentId, labelId],
  );
  const rows = useIncidentCollection(fetch);
  const [run, setRun] = useState("");
  return (
    <>
      <button type="button" onClick={rows.refresh}>
        {t("sources.refresh")}
      </button>
      {rows.loading && <p role="status">{t("sources.loading")}</p>}
      {rows.error && <p role="alert">{t("rules.loadError")}</p>}
      {!rows.loading && !rows.error && rows.items.length === 0 && (
        <p>{t("rules.noRows")}</p>
      )}
      {rows.items.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          client={client}
          scope={scope}
          t={t}
          proposal={proposal}
          canPropose={false}
          onRun={setRun}
        />
      ))}
      {rows.next && (
        <button
          type="button"
          disabled={rows.loading}
          onClick={() => void rows.more()}
        >
          {t("deployments.more")}
        </button>
      )}
      {run && <LinkedReport key={run} client={client} t={t} runId={run} />}
    </>
  );
}
function LinkedReport({
  client,
  t,
  runId,
}: {
  client: RulesClient;
  t: RuleText;
  runId: string;
}) {
  const [report, setReport] = useState<RuleReplayResult | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(false);
    setReport(null);
    void client
      .replayResult({ id: runId })
      .then((value) => {
        if (!current) return;
        if (!value || value.id !== runId) throw new Error("Report unavailable");
        setReport(value);
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
  }, [client, runId, reload]);
  return (
    <section>
      <button
        type="button"
        disabled={loading}
        onClick={() => setReload((n) => n + 1)}
      >
        {t("sources.refresh")}
      </button>
      {loading && <p role="status">{t("sources.loading")}</p>}
      {error && <p role="alert">{t("rules.loadError")}</p>}
      {report && <RuleBacktestSummary report={report} t={t} />}
      {report?.report && (
        <RuleReportDetails client={client} t={t} runId={runId} />
      )}
    </section>
  );
}
