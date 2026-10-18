import { TargetSetup } from "./TargetSetup.js";
import type { DeploymentSettingsClient } from "../deployment-settings-client.js";
import { styles } from "../incidents/styles.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeploymentWatchView,
  DeploymentCoverageDecision,
} from "../../contracts/index.js";
import type { DeploymentsClient } from "../deployments-client.js";
import type { IncidentsClient } from "../incidents-client.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import { IncidentDetail } from "../incidents/IncidentDetail.js";
import { WatchSummary } from "./WatchSummary.js";
import { CoverageProof } from "./CoverageProof.js";
type Text = (key: string) => string;
export function DeploymentsScreen({
  client,
  incidents,
  canResolve,
  settings,
  canManage = false,
  pagingAvailable = false,
  t,
}: {
  client: DeploymentsClient;
  incidents: IncidentsClient;
  canResolve: boolean;
  settings?: DeploymentSettingsClient;
  canManage?: boolean;
  pagingAvailable?: boolean;
  t: Text;
}) {
  const fetch = useCallback(
    (input: { after?: string; limit?: number }) => client.targets(input),
    [client],
  );
  const targets = useIncidentCollection(fetch);
  const [selection, setSelection] = useState<{
    client: DeploymentsClient;
    targetId: string;
  }>();
  const selected =
    selection?.client === client
      ? targets.items.find((x) => x.id === selection.targetId)
      : undefined;
  return (
    <section style={styles.card} aria-label={t("deployments.heading")}>
      <h1>{t("deployments.heading")}</h1>
      {canManage && settings && (
        <TargetSetup
          client={settings}
          target={selected}
          canActivate={pagingAvailable}
          onSaved={targets.refresh}
          t={t}
        />
      )}
      <p>{t("deployments.guidance")}</p>
      <button
        style={styles.button}
        disabled={targets.loading}
        onClick={targets.refresh}
      >
        {t("sources.refresh")}
      </button>
      {targets.loading && <p role="status">{t("sources.loading")}</p>}
      {targets.error && <p role="alert">{t("deployments.error")}</p>}
      {!targets.loading && !targets.error && !targets.items.length && (
        <p>{t("deployments.emptyTargets")}</p>
      )}
      <label style={styles.label}>
        {t("deployments.target")}{" "}
        <select
          style={styles.input}
          value={selected?.id ?? ""}
          onChange={(e) => setSelection({ client, targetId: e.target.value })}
        >
          <option value="">{t("deployments.choose")}</option>
          {targets.items.map((target) => (
            <option key={target.id} value={target.id}>
              {target.name} · {target.serviceId}/{target.environmentId}
              {target.enabled ? "" : ` (${t("deployments.disabled")})`}
            </option>
          ))}
        </select>
      </label>
      {targets.next && (
        <button
          style={styles.button}
          disabled={targets.loading}
          onClick={() => void targets.more()}
        >
          {t("deployments.more")}
        </button>
      )}
      {selected && (
        <History
          key={selected.id}
          client={client}
          targetId={selected.id}
          incidents={incidents}
          canResolve={canResolve}
          t={t}
        />
      )}
    </section>
  );
}
function History({
  client,
  targetId,
  incidents,
  canResolve,
  t,
}: {
  client: DeploymentsClient;
  targetId: string;
  incidents: IncidentsClient;
  canResolve: boolean;
  t: Text;
}) {
  const fetch = useCallback(
    (input: { after?: string; limit?: number }) =>
      client.history({ targetId, ...input }),
    [client, targetId],
  );
  const history = useIncidentCollection(fetch),
    [selected, setSelected] = useState<string>();
  return (
    <section style={styles.card} aria-label={t("deployments.history")}>
      <h2>{t("deployments.history")}</h2>
      <button
        style={styles.button}
        disabled={history.loading}
        onClick={history.refresh}
      >
        {t("sources.refresh")}
      </button>
      {history.loading && <p role="status">{t("sources.loading")}</p>}
      {history.error && <p role="alert">{t("deployments.error")}</p>}
      {!history.loading && !history.error && !history.items.length && (
        <p>{t("deployments.emptyHistory")}</p>
      )}
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th style={styles.cell}>{t("deployments.release")}</th>
              <th style={styles.cell}>{t("deployments.started")}</th>
              <th style={styles.cell}>{t("deployments.lifecycle")}</th>
            </tr>
          </thead>
          <tbody>
            {history.items.map((d) => (
              <tr key={d.id}>
                <td style={styles.cell}>
                  <button
                    style={styles.button}
                    aria-pressed={selected === d.id}
                    onClick={() => setSelected(d.id)}
                  >
                    {d.source}: {d.externalId}
                  </button>
                </td>
                <td style={styles.cell}>
                  <time dateTime={d.startedAt}>{d.startedAt}</time>
                </td>
                <td style={styles.cell}>
                  {t(`deployments.status.${d.status}`)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {history.next && (
        <button
          style={styles.button}
          disabled={history.loading}
          onClick={() => void history.more()}
        >
          {t("deployments.more")}
        </button>
      )}
      {selected && (
        <Detail
          key={selected}
          client={client}
          targetId={targetId}
          id={selected}
          incidents={incidents}
          canResolve={canResolve}
          t={t}
        />
      )}
    </section>
  );
}
function Detail({
  client,
  targetId,
  id,
  incidents,
  canResolve,
  t,
}: {
  client: DeploymentsClient;
  targetId: string;
  id: string;
  incidents: IncidentsClient;
  canResolve: boolean;
  t: Text;
}) {
  const [loaded, setLoaded] = useState<{
    client: DeploymentsClient;
    value: DeploymentWatchView;
    coverage?: DeploymentCoverageDecision;
    coverageError: boolean;
  }>();
  const [pending, setPending] = useState(true),
    [error, setError] = useState(false),
    [reload, setReload] = useState(0),
    [showIncident, setShowIncident] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setPending(true);
    setError(false);
    setLoaded(undefined);
    setShowIncident(false);
    void (async () => {
      try {
        const value = await client.detail({ targetId, id });
        if (current !== generation.current) return;
        if (value.targetId !== targetId || value.deployment.id !== id)
          throw new Error("scope");
        let coverage: DeploymentCoverageDecision | undefined,
          coverageError = false;
        if (value.deployment.coverageDecisionId)
          try {
            coverage = await client.coverage({
              targetId,
              decisionId: value.deployment.coverageDecisionId,
            });
            if (
              coverage.id !== value.deployment.coverageDecisionId ||
              coverage.binding.targetId !== targetId
            )
              throw new Error("scope");
          } catch {
            coverage = undefined;
            coverageError = true;
          }
        if (current === generation.current)
          setLoaded({ client, value, coverage, coverageError });
      } catch {
        if (current === generation.current) setError(true);
      } finally {
        if (current === generation.current) setPending(false);
      }
    })();
    return () => {
      generation.current++;
    };
  }, [client, targetId, id, reload]);
  const data = loaded?.client === client ? loaded : undefined;
  const refresh = () => setReload((x) => x + 1);
  return (
    <section style={styles.card} aria-label={t("deployments.detail")}>
      <h2>{t("deployments.detail")}</h2>
      <button style={styles.button} disabled={pending} onClick={refresh}>
        {t("sources.refresh")}
      </button>
      {pending && <p role="status">{t("sources.loading")}</p>}
      {error && <p role="alert">{t("deployments.error")}</p>}
      {data && !pending && !error && (
        <>
          <WatchSummary value={data.value} t={t} />
          <CoverageProof
            proof={data.coverage}
            linked={Boolean(data.value.deployment.coverageDecisionId)}
            error={data.coverageError}
            t={t}
          />
          {data.value.watch?.incidentId && (
            <>
              <button
                style={styles.button}
                aria-expanded={showIncident}
                onClick={() => setShowIncident((x) => !x)}
              >
                {t("deployments.incident")}: {data.value.watch.incidentId}
              </button>
              {showIncident && (
                <IncidentDetail
                  key={data.value.watch.incidentId}
                  client={incidents}
                  id={data.value.watch.incidentId}
                  canResolve={canResolve}
                  onResolved={refresh}
                  t={t}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
