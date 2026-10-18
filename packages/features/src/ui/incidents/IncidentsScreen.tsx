import type { InvestigationReportsClient } from "../investigation-reports-client.js";
import { useState } from "react";
import type { IncidentsClient } from "../incidents-client.js";
import { useIncidentCollection } from "./useIncidentCollection.js";
import { ManualIncident } from "./ManualIncident.js";
import { IncidentDetail } from "./IncidentDetail.js";
import { EnvironmentForm } from "./EnvironmentForm.js";
import { styles } from "./styles.js";
export function IncidentsScreen({
  client,
  reports,
  canCreate,
  canResolve,
  canManageEnvironment,
  t,
}: {
  client: IncidentsClient;
  reports?: InvestigationReportsClient;
  canCreate: boolean;
  canResolve: boolean;
  canManageEnvironment: boolean;
  t: (key: string) => string;
}) {
  const list = useIncidentCollection(client.list);
  const [selected, setSelected] = useState<string>();
  return (
    <section aria-label={t("incidents.heading")}>
      <h1>{t("incidents.heading")}</h1>
      {canManageEnvironment && <EnvironmentForm client={client} t={t} />}
      {canCreate && (
        <ManualIncident
          client={client}
          t={t}
          onCreated={(id) => {
            setSelected(id);
            list.refresh();
          }}
        />
      )}
      {list.error && <p role="alert">{t("incidents.error")}</p>}
      {list.loading && <p role="status">{t("incidents.loading")}</p>}
      <button
        style={styles.button}
        disabled={list.loading}
        onClick={list.refresh}
      >
        {t("incidents.refresh")}
      </button>
      {!list.loading && !list.items.length && !list.error && (
        <p>{t("incidents.empty")}</p>
      )}
      {list.items.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["title", "severity", "state", "opened"].map((key) => (
                  <th key={key} style={styles.cell} scope="col">
                    {t(`incidents.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.items.map((incident) => (
                <tr key={incident.id}>
                  <td style={styles.cell}>
                    <button
                      style={styles.button}
                      aria-pressed={selected === incident.id}
                      onClick={() => setSelected(incident.id)}
                    >
                      {incident.title}
                    </button>
                  </td>
                  <td style={styles.cell}>
                    {t(`incidents.severities.${incident.severity}`)}
                  </td>
                  <td style={styles.cell}>
                    {t(
                      incident.resolvedAt
                        ? "incidents.states.resolved"
                        : "incidents.active",
                    )}
                  </td>
                  <td style={styles.cell}>
                    <time dateTime={incident.openedAt}>
                      {new Date(incident.openedAt).toLocaleString()}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.next && (
        <button
          style={styles.button}
          disabled={list.loading}
          onClick={() => void list.more()}
        >
          {t("incidents.more")}
        </button>
      )}
      {selected && (
        <IncidentDetail
          key={selected}
          id={selected}
          client={client}
          reports={reports}
          canResolve={canResolve}
          onResolved={list.refresh}
          t={t}
        />
      )}
    </section>
  );
}
