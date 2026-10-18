import { useEffect, useState } from "react";
import type {
  MetricMonitor,
  MetricObservationRecord,
} from "../../contracts/index.js";
import { MetricObservation } from "./MetricObservation.js";
import type { MetricsClient } from "../metrics-client.js";
import { styles } from "../incidents/styles.js";
export function MetricStatus({
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
  const [detail, setDetail] = useState<{
    metric: MetricMonitor;
    lastObservation: MetricObservationRecord | null;
  }>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setError(false);
    setLoading(true);
    void client
      .get({ id })
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, id, version, reload]);
  const result = detail?.lastObservation;
  return (
    <section aria-label={t("monitoring.status")}>
      <h3>{t("monitoring.status")}</h3>
      <button
        style={styles.button}
        disabled={loading}
        onClick={() => setReload((value) => value + 1)}
      >
        {t("probes.refresh")}
      </button>
      {loading && <p role="status">{t("probes.loading")}</p>}
      {error && <p role="alert">{t("probes.error")}</p>}
      {detail && (
        <>
          <p>
            {detail.metric.enabled ? t("probes.enabled") : t("probes.disabled")}{" "}
            · {t("probes.version")} {detail.metric.version}
          </p>
          <p>{t("monitoring.snapshotHelp")}</p>
          {result ? (
            <MetricObservation
              observation={result}
              currentVersion={detail.metric.version}
              t={t}
            />
          ) : (
            <p>{t("probes.noResults")}</p>
          )}
        </>
      )}
    </section>
  );
}
