import { useEffect, useState } from "react";
import type { HeartbeatsClient } from "../heartbeats-client.js";
import type { HeartbeatState } from "../../contracts/index.js";
import { styles } from "../incidents/styles.js";
export function HeartbeatStatus({
  client,
  id,
  version,
  t,
}: {
  client: HeartbeatsClient;
  id: string;
  version: number;
  t: (key: string) => string;
}) {
  const [state, setState] = useState<HeartbeatState | null>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    setState(undefined);
    void client
      .get({ id })
      .then((detail) => {
        if (active) setState(detail.state);
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
  return (
    <section aria-label={t("heartbeats.status")}>
      <h3>{t("heartbeats.status")}</h3>
      <p>{t("monitoring.snapshotHelp")}</p>
      <button
        style={styles.button}
        disabled={loading}
        onClick={() => setReload((value) => value + 1)}
      >
        {t("sources.refresh")}
      </button>
      {loading && <p role="status">{t("sources.loading")}</p>}
      {error && <p role="alert">{t("sources.error")}</p>}
      {!loading && !error && (
        <dl>
          {(["lastAcceptedAt", "deadlineAt", "missedAt"] as const).map(
            (field) => (
              <div key={field}>
                <dt>{t("heartbeats." + field)}</dt>
                <dd>
                  {state?.[field] ? (
                    <time dateTime={state[field]!}>{state[field]}</time>
                  ) : (
                    t("heartbeats.none")
                  )}
                </dd>
              </div>
            ),
          )}
        </dl>
      )}
      <p>{t("heartbeats.statusHelp")}</p>
    </section>
  );
}
