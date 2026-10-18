import { useState } from "react";
import type { MetricMonitor } from "../../contracts/index.js";
import type { MetricsClient } from "../metrics-client.js";
import { useIncidentCollection as useCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
import { MetricEditor } from "./MetricEditor.js";
import { MetricStatus } from "./MetricStatus.js";
import { DetectionBindingEditor } from "../detection/DetectionBindingEditor.js";
import { MetricHistory } from "./MetricHistory.js";
export function MetricsScreen({
  client,
  canManage,
  t,
}: {
  client: MetricsClient;
  canManage: boolean;
  t: (key: string) => string;
}) {
  const sources = useCollection(client.list);
  const services = useCollection(client.services);
  const environments = useCollection(client.environments);
  const [selection, setSelection] = useState<{
    client: MetricsClient;
    source: MetricMonitor | null;
  }>();
  const selected = selection?.client === client ? selection.source : undefined;
  const loading = sources.loading || services.loading || environments.loading;

  return (
    <section aria-label={t("metrics.heading")}>
      <h1>{t("metrics.heading")}</h1>
      <p>{t("metrics.guidance")}</p>
      {loading && <p role="status">{t("sources.loading")}</p>}
      {(sources.error || services.error || environments.error) && (
        <p role="alert">{t("sources.error")}</p>
      )}
      <button
        style={styles.button}
        disabled={loading}
        onClick={() => {
          sources.refresh();
          services.refresh();
          environments.refresh();
          setSelection(undefined);
        }}
      >
        {t("sources.refresh")}
      </button>
      {canManage && (
        <button
          style={styles.button}
          disabled={loading || selected === null}
          onClick={() => setSelection({ client, source: null })}
        >
          {t("metrics.create")}
        </button>
      )}
      {!sources.loading && !sources.error && !sources.items.length && (
        <p>{t("metrics.empty")}</p>
      )}
      <ul>
        {sources.items.map((source) => (
          <li key={source.id}>
            <button
              style={styles.button}
              aria-pressed={selected?.id === source.id}
              onClick={() => setSelection({ client, source })}
            >
              {source.name}
            </button>
            {" · "}
            {source.enabled ? t("probes.enabled") : t("probes.disabled")}
            {" · "}
            {services.items.find((value) => value.id === source.serviceId)
              ?.name ?? source.serviceId}
            {" · "}
            {environments.items.find(
              (value) => value.id === source.environmentId,
            )?.name ?? source.environmentId}
          </li>
        ))}
      </ul>
      {sources.next && (
        <button
          style={styles.button}
          disabled={sources.loading}
          onClick={() => void sources.more()}
        >
          {t("metrics.more")}
        </button>
      )}
      {services.next && (
        <button
          style={styles.button}
          disabled={services.loading}
          onClick={() => void services.more()}
        >
          {t("probes.moreServices")}
        </button>
      )}
      {environments.next && (
        <button
          style={styles.button}
          disabled={environments.loading}
          onClick={() => void environments.more()}
        >
          {t("probes.moreEnvironments")}
        </button>
      )}
      {selected !== undefined && (
        <MetricEditor
          key={selected ? selected.id + ":" + selected.version : "new"}
          client={client}
          initial={selected ?? undefined}
          services={services.items}
          environments={environments.items}
          canManage={canManage}
          t={t}
          onSaved={(source) => {
            setSelection({ client, source });
            sources.refresh();
          }}
        />
      )}
      {selected && (
        <MetricHistory
          key={selected.id}
          client={client}
          id={selected.id}
          version={selected.version}
          t={t}
        />
      )}
      {selected && (
        <MetricStatus
          key={selected.id + ":" + selected.version}
          client={client}
          id={selected.id}
          version={selected.version}
          t={t}
        />
      )}
      {selected && (
        <DetectionBindingEditor
          key={selected.serviceId + ":" + selected.environmentId}
          client={client}
          serviceId={selected.serviceId}
          environmentId={selected.environmentId}
          canManage={canManage}
          t={t}
        />
      )}
    </section>
  );
}
