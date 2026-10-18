import { useCallback } from "react";
import type { MetricsClient } from "../metrics-client.js";
import type { ProbePageInput } from "../probes-client.js";
import { useIncidentCollection as useCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
import { MetricObservation } from "./MetricObservation.js";
export function MetricHistory({
  client,
  id,
  version,
  t,
}: {
  client: MetricsClient;
  id: string;
  version: number;
  t: (key: string) => string;
}) {
  const fetch = useCallback(
    (page: ProbePageInput) => client.history({ ...page, id }),
    [client, id],
  );
  const records = useCollection(fetch);
  return (
    <section aria-label={t("probes.history")}>
      <h3>{t("probes.history")}</h3>
      <p>{t("metrics.historyHelp")}</p>
      <button
        style={styles.button}
        disabled={records.loading}
        onClick={records.refresh}
      >
        {t("sources.refresh")}
      </button>
      {records.loading && <p role="status">{t("sources.loading")}</p>}
      {records.error && <p role="alert">{t("sources.error")}</p>}
      {!records.loading && !records.error && !records.items.length && (
        <p>{t("probes.noResults")}</p>
      )}
      <ul>
        {records.items.map((observation) => (
          <li key={observation.id}>
            <MetricObservation
              observation={observation}
              currentVersion={version}
              t={t}
            />
          </li>
        ))}
      </ul>
      {records.next && (
        <button
          style={styles.button}
          disabled={records.loading}
          onClick={() => void records.more()}
        >
          {t("probes.moreResults")}
        </button>
      )}
    </section>
  );
}
