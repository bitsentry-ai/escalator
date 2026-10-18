import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  MetricMonitor,
  Service,
  Environment,
} from "../../contracts/index.js";
import type { MetricsClient } from "../metrics-client.js";
import { MonitoringSecretPicker } from "../monitoring/MonitoringSecretPicker.js";
import { MonitoringCredentialForm } from "../monitoring/MonitoringCredentialForm.js";
import { styles } from "../incidents/styles.js";
import { readMetricForm } from "./form.js";
export function MetricEditor({
  client,
  initial,
  services,
  environments,
  canManage,
  onSaved,
  t,
}: {
  client: MetricsClient;
  initial?: MetricMonitor;
  services: Service[];
  environments: Environment[];
  canManage: boolean;
  onSaved: (value: MetricMonitor) => void;
  t: (key: string) => string;
}) {
  const [provider, setProvider] = useState(
    initial?.query.connection.provider ?? "prometheus",
  );
  const [secretId, setSecretId] = useState(
    initial?.query.connection.authSecretId ?? "",
  );
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || busy.current) return;
    const data = new FormData(event.currentTarget);
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const command = readMetricForm(data, initial);
      const result =
        command.kind === "create"
          ? await client.create(command.input)
          : await client.update(command.input);
      if (alive.current) onSaved(result);
    } catch {
      if (alive.current) setError(true);
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  async function disable() {
    if (!canManage || !initial || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const result = await client.disable({
        id: initial.id,
        expectedVersion: initial.version,
      });
      if (alive.current) onSaved(result);
    } catch {
      if (alive.current) setError(true);
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  return (
    <article style={styles.card}>
      <h2>{initial?.name ?? t("metrics.create")}</h2>
      {error && <p role="alert">{t("sources.error")}</p>}
      <form onSubmit={(event) => void save(event)}>
        <fieldset style={styles.form} disabled={!canManage || pending}>
          <label style={styles.label}>
            {t("probes.name")}
            <input
              style={styles.input}
              name="name"
              required
              maxLength={200}
              defaultValue={initial?.name}
            />
          </label>
          {!initial && (
            <>
              <label style={styles.label}>
                {t("probes.service")}
                <select
                  style={styles.input}
                  name="service"
                  required
                  defaultValue=""
                >
                  <option value="">{t("probes.choose")}</option>
                  {services
                    .filter((service) => service.enabled)
                    .map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                </select>
              </label>
              <label style={styles.label}>
                {t("probes.environment")}
                <select
                  style={styles.input}
                  name="environment"
                  required
                  defaultValue=""
                >
                  <option value="">{t("probes.choose")}</option>
                  {environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={initial?.enabled ?? false}
            />{" "}
            {t("probes.enabled")}
          </label>
          <label style={styles.label}>
            {t("metrics.provider")}
            <select
              style={styles.input}
              name="provider"
              value={provider}
              onChange={(event) => {
                if (
                  event.target.value === "prometheus" ||
                  event.target.value === "grafana-prometheus"
                )
                  setProvider(event.target.value);
              }}
            >
              <option value="prometheus">Prometheus</option>
              <option value="grafana-prometheus">Grafana · Prometheus</option>
            </select>
          </label>
          <label style={styles.label}>
            {t("metrics.url")}
            <input
              style={styles.input}
              name="url"
              type="url"
              required
              maxLength={1024}
              defaultValue={initial?.query.connection.baseUrl}
            />
          </label>
          {provider === "grafana-prometheus" && (
            <label style={styles.label}>
              {t("metrics.datasource")}
              <input
                style={styles.input}
                name="datasource"
                required
                pattern="[A-Za-z0-9_-]{1,40}"
                maxLength={40}
                defaultValue={
                  initial?.query.connection.provider === "grafana-prometheus"
                    ? initial.query.connection.datasourceUid
                    : ""
                }
              />
            </label>
          )}
          {canManage ? (
            <MonitoringSecretPicker
              key={revision}
              client={client}
              value={secretId}
              onChange={setSecretId}
              disabled={pending}
              name="authSecretId"
              t={t}
            />
          ) : (
            <p>
              {t("monitoring.retainedReference")}: {secretId}
            </p>
          )}
          <p>{t("metrics.queryHelp")}</p>
          <label style={styles.label}>
            {t("metrics.requests")}
            <textarea
              style={styles.input}
              name="requests"
              required
              maxLength={1000}
              defaultValue={initial?.query.requestsQuery}
            />
          </label>
          <label style={styles.label}>
            {t("metrics.errors")}
            <textarea
              style={styles.input}
              name="errors"
              required
              maxLength={1000}
              defaultValue={initial?.query.errorsQuery}
            />
          </label>
          {[
            {
              field: "step",
              min: 60,
              max: 3600,
              step: 1,
              value: initial?.stepSeconds ?? 60,
            },
            {
              field: "window",
              min: 120,
              max: 86400,
              step: 1,
              value: initial?.rule.windowSeconds ?? 300,
            },
            {
              field: "samples",
              min: 2,
              max: 1440,
              step: 1,
              value: initial?.rule.minimumSamples ?? 5,
            },
            {
              field: "minimumRequests",
              min: 1,
              max: Number.MAX_SAFE_INTEGER,
              step: 1,
              value: initial?.rule.minimumRequests ?? 100,
            },
            {
              field: "floor",
              min: 0,
              max: 100,
              step: "any",
              value: (initial?.rule.errorRateFloor ?? 0.01) * 100,
            },
          ].map((field) => (
            <label key={field.field} style={styles.label}>
              {t("metrics." + field.field)}
              <input
                style={styles.input}
                name={field.field}
                type="number"
                required
                min={field.min}
                max={field.max}
                step={field.step}
                defaultValue={field.value}
              />
            </label>
          ))}
          <p>{t("metrics.floorHelp")}</p>
          {canManage && (
            <button style={styles.button} type="submit">
              {t("metrics.save")}
            </button>
          )}
        </fieldset>
      </form>
      {initial && (
        <p>
          {t("probes.version")} {initial.version}
        </p>
      )}
      {canManage && initial?.enabled && (
        <button
          style={styles.button}
          disabled={pending}
          onClick={() => void disable()}
        >
          {t("probes.disable")}
        </button>
      )}
      {canManage && (
        <MonitoringCredentialForm
          client={client}
          kind="metrics"
          t={t}
          onCreated={(value) => {
            setSecretId(value.id);
            setRevision((value) => value + 1);
          }}
        />
      )}
      {pending && <p role="status">{t("settings.saving")}</p>}
      <p>{t("metrics.audit")}</p>
    </article>
  );
}
