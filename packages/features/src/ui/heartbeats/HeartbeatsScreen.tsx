import { useState } from "react";
import type { Heartbeat } from "../../contracts/index.js";
import type { HeartbeatsClient } from "../heartbeats-client.js";
import { useIncidentCollection as useCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
import { HeartbeatEditor } from "./HeartbeatEditor.js";
import { HeartbeatStatus } from "./HeartbeatStatus.js";
import { DetectionBindingEditor } from "../detection/DetectionBindingEditor.js";
import { HeartbeatGrants } from "./HeartbeatGrants.js";
export function HeartbeatsScreen({
  client,
  canManage,
  t,
}: {
  client: HeartbeatsClient;
  canManage: boolean;
  t: (key: string) => string;
}) {
  const sources = useCollection(client.list);
  const services = useCollection(client.services);
  const environments = useCollection(client.environments);
  const [selection, setSelection] = useState<{
    client: HeartbeatsClient;
    source: Heartbeat | null;
  }>();
  const selected = selection?.client === client ? selection.source : undefined;
  const loading = sources.loading || services.loading || environments.loading;

  return (
    <section aria-label={t("heartbeats.heading")}>
      <h1>{t("heartbeats.heading")}</h1>
      <p>{t("heartbeats.guidance")}</p>
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
          {t("heartbeats.create")}
        </button>
      )}
      {!sources.loading && !sources.error && !sources.items.length && (
        <p>{t("heartbeats.empty")}</p>
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
          {t("heartbeats.more")}
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
        <HeartbeatEditor
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
      {canManage && selected && (
        <HeartbeatGrants
          key={selected.id + ":" + selected.version}
          source={selected}
          client={client}
          t={t}
        />
      )}
      {selected && (
        <HeartbeatStatus
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
