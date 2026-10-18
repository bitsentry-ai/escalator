import { useCallback } from "react";
import type { ProbesClient, ProbePageInput } from "../probes-client.js";
import { useIncidentCollection as useCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
export function ProbeHistory({
  client,
  id,
  t,
}: {
  client: ProbesClient;
  id: string;
  t: (key: string) => string;
}) {
  const fetch = useCallback(
    (page: ProbePageInput) => client.history({ ...page, id }),
    [client, id],
  );
  const results = useCollection(fetch);
  return (
    <section aria-label={t("probes.history")}>
      <h3>{t("probes.history")}</h3>
      <button
        style={styles.button}
        disabled={results.loading}
        onClick={results.refresh}
      >
        {t("probes.refresh")}
      </button>
      {results.loading && <p role="status">{t("probes.loading")}</p>}
      {results.error && <p role="alert">{t("probes.error")}</p>}
      {!results.loading && !results.error && !results.items.length && (
        <p>{t("probes.noResults")}</p>
      )}
      <ul>
        {results.items.map((result) => (
          <li key={result.id}>
            <time dateTime={result.observedAt}>{result.observedAt}</time>
            {" · "}
            {t(`probes.outcomes.${result.outcome}`)}
            {" · "}
            {t(`probes.reasons.${result.reason}`)}
            {" · "}
            {t("probes.version")} {result.probeVersion}
            {" · "}
            {result.durationMs} ms
            {result.statusCode !== null && <> · HTTP {result.statusCode}</>}
          </li>
        ))}
      </ul>
      {results.next && (
        <button
          style={styles.button}
          disabled={results.loading}
          onClick={() => void results.more()}
        >
          {t("probes.moreResults")}
        </button>
      )}
    </section>
  );
}
