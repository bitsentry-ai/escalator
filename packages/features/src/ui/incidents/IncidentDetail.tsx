import { IncidentRuleProposals } from "../rules/IncidentRuleProposals.js";
import type { RulesClient } from "../rules/client.js";
import { IncidentLabels } from "../labels/LabelsScreen.js";
import type { LabelsClient } from "../labels/client.js";
import { InvestigationReportPanel } from "../investigation/InvestigationReportPanel.js";
import type { InvestigationReportsClient } from "../investigation-reports-client.js";
import { styles } from "./styles.js";
import { useEffect, useRef, useState } from "react";
import type {
  IncidentDetail as Detail,
  IncidentDelivery,
} from "../../contracts/index.js";
import type { IncidentsClient } from "../incidents-client.js";
export function IncidentDetail({
  client,
  reports,
  labels,
  rules,
  id,
  canResolve,
  onResolved,
  t,
}: {
  client: IncidentsClient;
  reports?: InvestigationReportsClient;
  labels?: LabelsClient;
  rules?: RulesClient;
  id: string;
  canResolve: boolean;
  onResolved: () => void;
  t: (key: string) => string;
}) {
  const [detail, setDetail] = useState<Detail>();
  const [deliveries, setDeliveries] = useState<IncidentDelivery[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    busy.current = true;
    setPending(true);
    setError(false);
    setDetail(undefined);
    setDeliveries([]);
    setNext(null);
    void Promise.all([
      client.detail({ id }),
      client.deliveries({ incidentId: id }),
    ])
      .then(([value, history]) => {
        if (current === generation.current) {
          setDetail(value);
          setDeliveries(history.items);
          setNext(history.next);
        }
      })
      .catch(() => {
        if (current === generation.current) setError(true);
      })
      .finally(() => {
        if (current === generation.current) {
          busy.current = false;
          setPending(false);
        }
      });
    return () => {
      generation.current++;
    };
  }, [client, id, reload]);
  async function run(action: (current: number) => Promise<void>) {
    if (busy.current) return;
    const current = generation.current;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      await action(current);
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  function loadDeliveries() {
    if (!next) return;
    void run(async (current) => {
      const page = await client.deliveries({ incidentId: id, after: next });
      if (current === generation.current) {
        setDeliveries((previous) => [
          ...previous,
          ...page.items.filter(
            (item) => !previous.some((old) => old.id === item.id),
          ),
        ]);
        setNext(page.next);
      }
    });
  }
  function loadAttempts(delivery: IncidentDelivery) {
    const after = delivery.attempts.next;
    if (!after) return;
    void run(async (current) => {
      const page = await client.attempts({
        incidentId: id,
        deliveryId: delivery.id,
        after,
      });
      if (current === generation.current)
        setDeliveries((previous) =>
          previous.map((item) =>
            item.id !== delivery.id
              ? item
              : {
                  ...item,
                  attempts: {
                    next: page.next,
                    items: [
                      ...item.attempts.items,
                      ...page.items.filter(
                        (attempt) =>
                          !item.attempts.items.some(
                            (old) => old.id === attempt.id,
                          ),
                      ),
                    ],
                  },
                },
          ),
        );
    });
  }
  const time = (value: string) => (
    <time dateTime={value}>{new Date(value).toLocaleString()}</time>
  );
  return (
    <section
      style={styles.card}
      aria-label={t("incidents.detail")}
      aria-busy={pending}
    >
      {error && <p role="alert">{t("incidents.error")}</p>}
      {pending && <p role="status">{t("incidents.loading")}</p>}
      <button
        style={styles.button}
        disabled={pending}
        onClick={() => setReload((value) => value + 1)}
      >
        {t("incidents.refresh")}
      </button>
      {detail && (
        <>
          <h2>{detail.incident.title}</h2>
          {rules && (
            <IncidentRuleProposals
              key={detail.incident.id}
              client={rules}
              incident={detail.incident}
              t={t}
            />
          )}
          {labels && (
            <IncidentLabels
              key={detail.incident.id}
              client={labels}
              scope={{
                serviceId: detail.incident.serviceId,
                environmentId: detail.incident.environmentId,
              }}
              incident={detail.incident}
              canLabel={canResolve}
              t={t}
            />
          )}
          {reports && (
            <InvestigationReportPanel
              client={reports}
              scope={{
                workspaceId: detail.incident.workspaceId,
                serviceId: detail.incident.serviceId,
                environmentId: detail.incident.environmentId,
                incidentId: detail.incident.id,
              }}
              t={t}
            />
          )}
          <dl>
            <dt>{t("incidents.state")}</dt>
            <dd>{t(`incidents.states.${detail.state}`)}</dd>
            <dt>{t("incidents.owner")}</dt>
            <dd>{detail.owner?.displayName ?? t("incidents.unowned")}</dd>
            <dt>{t("incidents.opened")}</dt>
            <dd>{time(detail.incident.openedAt)}</dd>
            {detail.acknowledgedAt && (
              <>
                <dt>{t("incidents.acknowledged")}</dt>
                <dd>{time(detail.acknowledgedAt)}</dd>
              </>
            )}
            {detail.resolvedAt && (
              <>
                <dt>{t("incidents.resolved")}</dt>
                <dd>{time(detail.resolvedAt)}</dd>
              </>
            )}
          </dl>
          {canResolve && detail.state !== "resolved" && (
            <button
              style={styles.button}
              disabled={pending}
              onClick={() =>
                void run(async (current) => {
                  await client.resolve({ id });
                  if (current === generation.current) {
                    setReload((value) => value + 1);
                    onResolved();
                  }
                })
              }
            >
              {t("incidents.resolve")}
            </button>
          )}
          <h3>{t("incidents.timeline")}</h3>
          <ol>
            {detail.timeline.map((step) => (
              <li key={step.id}>
                {time(step.dueAt)} — {t(`incidents.targets.${step.target}`)} —{" "}
                {t(`incidents.dispositions.${step.disposition}`)} (
                {step.recipientCount})
              </li>
            ))}
          </ol>
          <h3>{t("incidents.deliveries")}</h3>
          {!deliveries.length && <p>{t("incidents.noDeliveries")}</p>}
          {deliveries.map((delivery) => (
            <section
              style={styles.card}
              key={delivery.id}
              aria-label={delivery.recipient.displayName}
            >
              <h4>
                {delivery.recipient.displayName} · {delivery.channel}
              </h4>
              <ol>
                {[...delivery.attempts.items]
                  .sort((a, b) => a.attempt - b.attempt)
                  .map((attempt) => (
                    <li key={attempt.id}>
                      {t("incidents.attempt")} {attempt.attempt}:{" "}
                      {t(`incidents.outcomes.${attempt.outcome}`)} —{" "}
                      {time(attempt.startedAt)}
                      {attempt.completedAfterAcknowledgement && (
                        <> · {t("incidents.afterAck")}</>
                      )}
                    </li>
                  ))}
              </ol>
              {delivery.attempts.next && (
                <button
                  style={styles.button}
                  disabled={pending}
                  onClick={() => loadAttempts(delivery)}
                >
                  {t("incidents.moreAttempts")}
                </button>
              )}
            </section>
          ))}
          {next && (
            <button
              style={styles.button}
              disabled={pending}
              onClick={loadDeliveries}
            >
              {t("incidents.moreDeliveries")}
            </button>
          )}
        </>
      )}
    </section>
  );
}
