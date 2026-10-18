import { useEffect, useId, useRef, useState } from "react";
import {
  investigationViewSchema,
  type InvestigationScope,
  type InvestigationView,
} from "../../contracts/index.js";
import type { InvestigationReportsClient } from "../investigation-reports-client.js";
import { styles } from "../incidents/styles.js";
const scopeKey = (scope: InvestigationScope) =>
  JSON.stringify([
    scope.workspaceId,
    scope.serviceId,
    scope.environmentId,
    scope.incidentId,
  ]);
export function InvestigationReportPanel({
  client,
  scope,
  t,
}: {
  client: InvestigationReportsClient;
  scope: InvestigationScope;
  t: (key: string) => string;
}) {
  const key = scopeKey(scope);
  const prefix = useId();
  const generation = useRef(0);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{
    client: InvestigationReportsClient;
    key: string;
    view?: InvestigationView;
    error?: boolean;
  }>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const current = ++generation.current;
    setPending(true);
    setState({ client, key });
    void client
      .read({ id: scope.incidentId })
      .then((value) => {
        const view = investigationViewSchema.parse(value);
        if (scopeKey(view.scope) !== key)
          throw new Error("Investigation scope mismatch");
        if (current === generation.current) setState({ client, key, view });
      })
      .catch(() => {
        if (current === generation.current)
          setState({ client, key, error: true });
      })
      .finally(() => {
        if (current === generation.current) setPending(false);
      });
    return () => {
      generation.current++;
    };
  }, [client, key, scope.incidentId, reload]);
  const current =
    state?.client === client && state.key === key ? state : undefined;
  const view = current?.view;
  const run = view?.run;
  const report = run?.report;
  const time = (at: string) => (
    <time dateTime={at}>{new Date(at).toLocaleString()}</time>
  );
  const referenceId = (id: string) => `${prefix}-evidence-${id}`;
  return (
    <section
      style={styles.card}
      aria-label={t("investigationReport.heading")}
      aria-busy={pending}
    >
      <h3>{t("investigationReport.heading")}</h3>
      <button
        style={styles.button}
        disabled={pending}
        onClick={() => setReload((value) => value + 1)}
      >
        {t("investigationReport.refresh")}
      </button>
      {pending && <p role="status">{t("investigationReport.loading")}</p>}
      {current?.error && <p role="alert">{t("investigationReport.error")}</p>}
      {view && (
        <>
          <p>{t(`investigationReport.execution.${view.execution}`)}</p>
          <p>
            {t("investigationReport.observedAt")}: {time(view.observedAt)}
          </p>
          {!run && <p>{t("investigationReport.empty")}</p>}
        </>
      )}
      {run && (
        <>
          <p>{t(`investigationReport.states.${run.state}`)}</p>
          <dl>
            <dt>{t("investigationReport.attempts")}</dt>
            <dd>{run.attempts}</dd>
            <dt>{t("investigationReport.configuredDestination")}</dt>
            <dd>
              {run.destination.provider} / {run.destination.model} /{" "}
              {t(`investigationReport.locations.${run.destination.location}`)} /{" "}
              <code>{run.destination.origin}</code>
            </dd>
          </dl>
        </>
      )}
      {report && (
        <>
          <p>
            {t(`investigationReport.outcomes.${report.status}`)}:{" "}
            {t(`investigationReport.reasons.${report.reason}`)}
          </p>
          <p>
            {t("investigationReport.finishedAt")}: {time(report.finishedAt)}
          </p>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {report.summary}
          </p>
          <ul>
            {report.findings.map((finding, index) => (
              <li key={index}>
                <p>{finding.text}</p>
                {finding.evidenceIds.map((id) => (
                  <a
                    key={id}
                    href={`#${encodeURIComponent(referenceId(id))}`}
                    style={{ marginRight: 8 }}
                  >
                    [{report.evidence.findIndex((item) => item.id === id) + 1}]
                  </a>
                ))}
              </li>
            ))}
          </ul>
          <h4>{t("investigationReport.evidence")}</h4>
          <ol>
            {report.evidence.map((reference) => {
              const item = run?.evidence.find(
                (value) => value.reference.id === reference.id,
              );
              return (
                <li key={reference.id} id={referenceId(reference.id)}>
                  <p>
                    <code>{reference.sourceId}</code> /{" "}
                    {t(`investigationReport.kinds.${reference.kind}`)}
                  </p>
                  <p>
                    {t("investigationReport.observedAt")}:{" "}
                    {time(reference.observedAt)};{" "}
                    {t("investigationReport.receivedAt")}:{" "}
                    {time(reference.receivedAt)}
                  </p>
                  {item ? (
                    <>
                      <p>
                        {t("investigationReport.collectedAt")}:{" "}
                        {time(item.collectedAt)}
                      </p>
                      {item.truncated && (
                        <p>{t("investigationReport.truncated")}</p>
                      )}
                      <pre
                        style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {item.text}
                      </pre>
                    </>
                  ) : (
                    <p>{t("investigationReport.snapshotMissing")}</p>
                  )}
                </li>
              );
            })}
          </ol>
          <h4>{t("investigationReport.unavailable")}</h4>
          {report.unavailable.length === 0 ? (
            <p>{t("investigationReport.noneUnavailable")}</p>
          ) : (
            <ul>
              {report.unavailable.map((item, index) => (
                <li key={index}>
                  <code>{item.query.sourceId}</code> /{" "}
                  {t(`investigationReport.kinds.${item.query.kind}`)}:{" "}
                  {t(`investigationReport.unavailableReasons.${item.reason}`)}
                  <p>
                    {time(item.query.window.from)} –{" "}
                    {time(item.query.window.to)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
