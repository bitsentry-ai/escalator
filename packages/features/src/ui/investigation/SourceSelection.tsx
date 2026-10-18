import { useCallback, useState } from "react";
import type { InvestigationSourceSelection } from "../../contracts/index.js";
import type { InvestigationSettingsClient } from "../investigation-settings-client.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import type { IncidentPageInput } from "../../contracts/index.js";
import { styles } from "../incidents/styles.js";
type Kind = InvestigationSourceSelection["kind"];
export function SourceSelection({
  client,
  scope,
  value,
  onChange,
  t,
}: {
  client: InvestigationSettingsClient;
  scope: { serviceId: string; environmentId: string };
  value: InvestigationSourceSelection[];
  onChange: (value: InvestigationSourceSelection[]) => void;
  t: (key: string) => string;
}) {
  const [kind, setKind] = useState<Kind>("alert");
  return (
    <section aria-label={t("investigationSettings.sources")}>
      <h3>{t("investigationSettings.sources")}</h3>
      <p>{t("investigationSettings.sourceGuidance")}</p>
      <label>
        {t("investigationSettings.kind")}{" "}
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="alert">{t("sources.heading")}</option>
          <option value="probe">{t("probes.heading")}</option>
          <option value="metric">{t("metrics.heading")}</option>
          <option value="deployment">{t("deployments.heading")}</option>
        </select>
      </label>
      <SourceOptions
        key={`${kind}:${scope.serviceId}:${scope.environmentId}`}
        client={client}
        scope={scope}
        kind={kind}
        value={value}
        onChange={onChange}
        t={t}
      />
      {value.map((source, index) => (
        <fieldset key={`${source.kind}:${source.sourceId}`} style={styles.form}>
          <legend>
            {source.kind} · {source.sourceId}
          </legend>
          <label>
            {t("investigationSettings.lookback")}{" "}
            <input
              type="number"
              required
              min={1}
              max={86400}
              step={1}
              value={source.lookbackMs / 1000}
              onChange={(e) =>
                onChange(
                  value.map((item, i) =>
                    i === index
                      ? { ...item, lookbackMs: Number(e.target.value) * 1000 }
                      : item,
                  ),
                )
              }
            />
          </label>
          <label>
            {t("investigationSettings.resultLimit")}{" "}
            <input
              type="number"
              required
              min={1}
              max={100}
              step={1}
              value={source.limit}
              onChange={(e) =>
                onChange(
                  value.map((item, i) =>
                    i === index
                      ? { ...item, limit: Number(e.target.value) }
                      : item,
                  ),
                )
              }
            />
          </label>
          <button
            type="button"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            {t("investigationSettings.remove")}
          </button>
        </fieldset>
      ))}
    </section>
  );
}

function SourceOptions({
  client,
  scope,
  kind,
  value,
  onChange,
  t,
}: {
  client: InvestigationSettingsClient;
  scope: { serviceId: string; environmentId: string };
  kind: Kind;
  value: InvestigationSourceSelection[];
  onChange: (value: InvestigationSourceSelection[]) => void;
  t: (key: string) => string;
}) {
  const fetch = useCallback(
    async (page: IncidentPageInput) => {
      const result = await client.sources({ ...scope, kind, ...page });
      return {
        ...result,
        items: result.items.map((item) => ({ ...item, id: item.sourceId })),
      };
    },
    [client, scope.serviceId, scope.environmentId, kind],
  );
  const options = useIncidentCollection(fetch);
  return (
    <>
      {options.loading && <p role="status">{t("sources.loading")}</p>}
      {options.error && (
        <p role="alert">{t("investigationSettings.loadError")}</p>
      )}
      <button
        type="button"
        disabled={options.loading}
        onClick={options.refresh}
      >
        {t("sources.refresh")}
      </button>
      {!options.loading &&
        !options.error &&
        options.items.map((item) => (
          <div key={item.id}>
            <span>
              {item.name} · {item.sourceId}
            </span>{" "}
            <button
              type="button"
              disabled={
                value.length >= 32 ||
                value.some(
                  (source) =>
                    source.kind === kind && source.sourceId === item.sourceId,
                )
              }
              onClick={() =>
                onChange([
                  ...value,
                  {
                    kind,
                    sourceId: item.sourceId,
                    lookbackMs: 1800000,
                    limit: 25,
                  },
                ])
              }
            >
              {t("investigationSettings.add")}
            </button>
          </div>
        ))}
      {options.next && (
        <button
          type="button"
          disabled={options.loading}
          onClick={() => void options.more()}
        >
          {t("deployments.more")}
        </button>
      )}
    </>
  );
}
