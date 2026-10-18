import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDeploymentTargetSchema,
  updateDeploymentTargetSchema,
  type DeploymentTarget,
} from "../../contracts/index.js";
import type { DeploymentSettingsClient } from "../deployment-settings-client.js";
import type { ProbeCollection, ProbePageInput } from "../probes-client.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
type Text = (key: string) => string;
export function TargetEditor({
  client,
  initial,
  canActivate,
  onSaved,
  onCancel,
  t,
}: {
  client: DeploymentSettingsClient;
  initial?: DeploymentTarget;
  canActivate: boolean;
  onSaved: () => void;
  onCancel: () => void;
  t: Text;
}) {
  const [name, setName] = useState(initial?.name ?? ""),
    [serviceId, setService] = useState<string>(initial?.serviceId ?? ""),
    [environmentId, setEnvironment] = useState<string>(
      initial?.environmentId ?? "",
    ),
    [policyId, setPolicy] = useState(initial?.policyId ?? ""),
    [timeout, setTimeoutValue] = useState(
      String(initial?.timeoutSeconds ?? 600),
    ),
    [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(false);
  const generation = useRef(0),
    busy = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [client],
  );
  const services = useCallback(
    (page: ProbePageInput) => client.services(page),
    [client],
  );
  const environments = useCallback(
    (page: ProbePageInput) => client.environments(page),
    [client],
  );
  const policies = useCallback(
    async (page: ProbePageInput) => {
      const result = await client.policies(page);
      return {
        ...result,
        items: result.items
          .filter((p) => p.serviceId === serviceId)
          .map((p) => ({ id: p.id, name: `${p.id} (v${p.version})` })),
      };
    },
    [client, serviceId],
  );
  async function save() {
    if (busy.current || (enabled && !canActivate)) return;
    busy.current = true;
    setPending(true);
    setError(false);
    const current = generation.current;
    try {
      const fields = {
        name,
        enabled,
        policyId,
        timeoutSeconds: Number(timeout),
      };
      if (initial)
        await client.update(
          updateDeploymentTargetSchema.parse({
            id: initial.id,
            expectedRevision: initial.revision,
            ...fields,
          }),
        );
      else
        await client.create(
          createDeploymentTargetSchema.parse({
            serviceId,
            environmentId,
            ...fields,
          }),
        );
      if (current === generation.current) onSaved();
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  return (
    <form
      style={styles.card}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{t(initial ? "deploymentSetup.edit" : "deploymentSetup.create")}</h3>
      {!canActivate && <p>{t("deploymentSetup.unavailable")}</p>}
      {error && <p role="alert">{t("deploymentSetup.saveError")}</p>}
      <fieldset disabled={pending} style={styles.form}>
        <label style={styles.label}>
          {t("deploymentSetup.name")}
          <input
            style={styles.input}
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Choice
          key="service"
          label={t("deploymentSetup.service")}
          fetch={services}
          value={serviceId}
          disabled={Boolean(initial)}
          onChange={(value) => {
            setService(value);
            setPolicy("");
          }}
          t={t}
        />
        <Choice
          key="environment"
          label={t("deploymentSetup.environment")}
          fetch={environments}
          value={environmentId}
          disabled={Boolean(initial)}
          onChange={setEnvironment}
          t={t}
        />
        <Choice
          key={`policy:${serviceId}`}
          label={t("deploymentSetup.policy")}
          fetch={policies}
          value={policyId}
          onChange={setPolicy}
          t={t}
        />
        <label style={styles.label}>
          {t("deploymentSetup.timeout")}
          <input
            style={styles.input}
            type="number"
            required
            min={60}
            max={86400}
            step={1}
            value={timeout}
            onChange={(e) => setTimeoutValue(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canActivate && !enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t("deploymentSetup.enabled")}
        </label>
        <button
          style={styles.button}
          type="submit"
          disabled={enabled && !canActivate}
        >
          {t("deploymentSetup.save")}
        </button>
        <button style={styles.button} type="button" onClick={onCancel}>
          {t("deploymentSetup.cancel")}
        </button>
      </fieldset>
    </form>
  );
}
function Choice({
  label,
  fetch,
  value,
  disabled = false,
  onChange,
  t,
}: {
  label: string;
  fetch: (
    page: ProbePageInput,
  ) => Promise<ProbeCollection<{ id: string; name: string }>>;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  t: Text;
}) {
  const list = useIncidentCollection(fetch);
  return (
    <div>
      <label style={styles.label}>
        {label}
        <select
          style={styles.input}
          required
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{t("deployments.choose")}</option>
          {value && !list.items.some((x) => x.id === value) && (
            <option value={value}>{value}</option>
          )}
          {list.items.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      {list.loading && <p role="status">{t("sources.loading")}</p>}
      {list.error && <p role="alert">{t("deploymentSetup.optionsError")}</p>}
      {list.error && (
        <button
          style={styles.button}
          type="button"
          disabled={list.loading}
          onClick={list.refresh}
        >
          {t("sources.refresh")}
        </button>
      )}
      {list.next && (
        <button
          style={styles.button}
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
