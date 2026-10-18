import { useState } from "react";
import type { Probe } from "../../contracts/index.js";
import type { ProbesClient } from "../probes-client.js";
import { useIncidentCollection as useCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
import { ProbeEditor } from "./ProbeEditor.js";
import { ProbeHistory } from "./ProbeHistory.js";
export function ProbesScreen({
  client,
  canManage,
  t,
}: {
  client: ProbesClient;
  canManage: boolean;
  t: (key: string) => string;
}) {
  const probes = useCollection(client.list);
  const services = useCollection(client.services);
  const environments = useCollection(client.environments);
  const [selection, setSelection] = useState<{
    client: ProbesClient;
    probe: Probe | null;
  }>();
  const selected = selection?.client === client ? selection.probe : undefined;
  const loading = probes.loading || services.loading || environments.loading;
  return (
    <section aria-label={t("probes.heading")}>
      <h1>{t("probes.heading")}</h1>
      <p>{t("probes.guidance")}</p>
      {loading && <p role="status">{t("probes.loading")}</p>}
      {(probes.error || services.error || environments.error) && (
        <p role="alert">{t("probes.error")}</p>
      )}
      <button
        style={styles.button}
        disabled={loading}
        onClick={() => {
          probes.refresh();
          services.refresh();
          environments.refresh();
        }}
      >
        {t("probes.refresh")}
      </button>
      {canManage && (
        <button
          style={styles.button}
          disabled={loading || selected === null}
          onClick={() => setSelection({ client, probe: null })}
        >
          {t("probes.create")}
        </button>
      )}
      {!probes.loading && !probes.error && !probes.items.length && (
        <p>{t("probes.empty")}</p>
      )}
      <ul>
        {probes.items.map((probe) => (
          <li key={probe.id}>
            <button
              style={styles.button}
              aria-pressed={selected?.id === probe.id}
              onClick={() => setSelection({ client, probe })}
            >
              {probe.name}
            </button>
            {" · "}
            {probe.enabled ? t("probes.enabled") : t("probes.disabled")}
            {" · "}
            {services.items.find((service) => service.id === probe.serviceId)
              ?.name ?? probe.serviceId}
          </li>
        ))}
      </ul>
      {probes.next && (
        <button
          style={styles.button}
          disabled={probes.loading}
          onClick={() => void probes.more()}
        >
          {t("probes.moreProbes")}
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
        <ProbeEditor
          key={selected ? `${selected.id}:${selected.version}` : "new"}
          client={client}
          initial={selected ?? undefined}
          services={services.items}
          environments={environments.items}
          canManage={canManage}
          t={t}
          onSaved={(probe) => {
            setSelection({ client, probe });
            probes.refresh();
          }}
        />
      )}
      {selected && (
        <ProbeHistory
          key={selected.id}
          client={client}
          id={selected.id}
          t={t}
        />
      )}
    </section>
  );
}
