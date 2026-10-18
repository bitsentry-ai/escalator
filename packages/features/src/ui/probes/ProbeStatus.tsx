import { useEffect, useState } from "react";
import type { ProbeInspection } from "../../contracts/index.js";
import type { ProbesClient } from "../probes-client.js";
import { styles } from "../incidents/styles.js";
export function ProbeStatus({
  client,
  id,
  version,
  t,
}: {
  client: ProbesClient;
  id: string;
  version: number;
  t: (key: string) => string;
}) {
  const [detail, setDetail] = useState<ProbeInspection>();
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
  const result = detail?.lastResult;
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
            {detail.probe.enabled ? t("probes.enabled") : t("probes.disabled")}{" "}
            · {t("probes.version")} {detail.probe.version}
          </p>
          <p>{t("monitoring.snapshotHelp")}</p>
          {detail.state && (
            <p>
              {detail.state.active
                ? t("monitoring.failureActive")
                : t("monitoring.noActiveFailure")}
            </p>
          )}
          {result ? (
            <>
              <p>
                <time dateTime={result.observedAt}>{result.observedAt}</time> ·{" "}
                {t("probes.version")} {result.probeVersion}
              </p>
              <p>
                {t("probes.outcomes." + result.outcome)} ·{" "}
                {t("probes.reasons." + result.reason)}
              </p>
              {result.probeVersion !== detail.probe.version && (
                <p>{t("monitoring.previousVersion")}</p>
              )}
            </>
          ) : (
            <p>{t("probes.noResults")}</p>
          )}
        </>
      )}
    </section>
  );
}
