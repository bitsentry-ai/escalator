import { modelProfileSchema } from "../../contracts/index.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  InvestigationSettings,
  IncidentPageInput,
} from "../../contracts/index.js";
import type { InvestigationSettingsClient } from "../investigation-settings-client.js";
import type { IncidentCollection } from "../incidents-client.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import { SettingsEditor } from "./SettingsEditor.js";
import { styles } from "../incidents/styles.js";
type Text = (key: string) => string;
export function InvestigationSettingsScreen({
  client,
  canManage,
  t,
}: {
  client: InvestigationSettingsClient;
  canManage: boolean;
  t: Text;
}) {
  const [service, setService] = useState(""),
    [environment, setEnvironment] = useState("");
  const services = useCallback(
    (page: IncidentPageInput) => client.services(page),
    [client],
  );
  const environments = useCallback(
    (page: IncidentPageInput) => client.environments(page),
    [client],
  );
  return (
    <section
      style={styles.card}
      aria-label={t("investigationSettings.heading")}
    >
      <h1>{t("investigationSettings.heading")}</h1>
      <p>{t("investigationSettings.guidance")}</p>
      <Choice
        fetch={services}
        label={t("deploymentSetup.service")}
        value={service}
        onChange={setService}
        t={t}
      />
      <Choice
        fetch={environments}
        label={t("deploymentSetup.environment")}
        value={environment}
        onChange={setEnvironment}
        t={t}
      />
      {service && environment && (
        <ScopeSettings
          key={`${service}:${environment}`}
          client={client}
          scope={{ serviceId: service, environmentId: environment }}
          canManage={canManage}
          t={t}
        />
      )}
    </section>
  );
}
function Choice({
  fetch,
  label,
  value,
  onChange,
  t,
}: {
  fetch: (
    page: IncidentPageInput,
  ) => Promise<IncidentCollection<{ id: string; name: string }>>;
  label: string;
  value: string;
  onChange: (value: string) => void;
  t: Text;
}) {
  const list = useIncidentCollection(fetch);
  return (
    <div>
      <label>
        {label}{" "}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={list.loading || list.error}
        >
          <option value="">{t("deployments.choose")}</option>
          {list.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {list.loading && <p role="status">{t("sources.loading")}</p>}
      {list.error && (
        <>
          <p role="alert">{t("investigationSettings.loadError")}</p>
          <button type="button" onClick={list.refresh}>
            {t("sources.refresh")}
          </button>
        </>
      )}
      {list.next && (
        <button
          type="button"
          disabled={list.loading}
          onClick={() => void list.more()}
        >
          {t("deployments.more")}
        </button>
      )}
    </div>
  );
}
function ScopeSettings({
  client,
  scope,
  canManage,
  t,
}: {
  client: InvestigationSettingsClient;
  scope: { serviceId: string; environmentId: string };
  canManage: boolean;
  t: Text;
}) {
  const [loaded, setLoaded] = useState<{
    client: InvestigationSettingsClient;
    settings: InvestigationSettings | undefined;
  }>();
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(false),
    [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setLoaded(undefined);
    setLoading(true);
    setError(false);
    void Promise.resolve()
      .then(() =>
        client.get(
          modelProfileSchema.shape.scope
            .omit({ workspaceId: true })
            .parse(scope),
        ),
      )
      .then((settings) => {
        if (current === generation.current) setLoaded({ client, settings });
      })
      .catch(() => {
        if (current === generation.current) setError(true);
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [client, scope.serviceId, scope.environmentId, reload]);
  const initial = loaded?.client === client ? loaded.settings : undefined;
  return (
    <div>
      <button
        type="button"
        disabled={loading}
        onClick={() => setReload((value) => value + 1)}
      >
        {t("sources.refresh")}
      </button>
      {loading && <p role="status">{t("sources.loading")}</p>}
      {error && <p role="alert">{t("investigationSettings.loadError")}</p>}
      {!loading && !error && loaded?.client === client && (
        <SettingsEditor
          key={`${initial?.profile.revision ?? 0}:${reload}`}
          client={client}
          scope={scope}
          initial={initial}
          canManage={canManage}
          onSaved={() => setReload((value) => value + 1)}
          t={t}
        />
      )}
    </div>
  );
}
