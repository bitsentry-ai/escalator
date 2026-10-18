import { MonitoringCredentialForm } from "../monitoring/MonitoringCredentialForm.js";
import { MonitoringSecretPicker } from "../monitoring/MonitoringSecretPicker.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  type Probe,
  type Service,
  type Environment,
} from "../../contracts/index.js";
import type { ProbesClient } from "../probes-client.js";
import { readProbeForm } from "./form.js";
import { styles } from "../incidents/styles.js";
export function ProbeEditor({
  client,
  initial,
  services,
  environments,
  canManage,
  t,
  onSaved,
}: {
  client: ProbesClient;
  initial?: Probe;
  services: Service[];
  environments: Environment[];
  canManage: boolean;
  t: (key: string) => string;
  onSaved: (probe: Probe) => void;
}) {
  const [secretId, setSecretId] = useState(initial?.config.authSecretId ?? "");
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [method, setMethod] = useState(initial?.config.method ?? "GET");
  const [critical, setCritical] = useState(initial?.critical ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"invalid" | "saveError">();
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function write(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || busy.current) return;
    const values = new FormData(event.currentTarget);
    let input;
    try {
      input = readProbeForm(values, initial);
    } catch {
      setError("invalid");
      return;
    }
    busy.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const value =
        input.kind === "update"
          ? await client.update(input.input)
          : await client.create(input.input);
      if (alive.current) onSaved(value);
    } catch {
      if (alive.current) setError("saveError");
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  }
  async function disable() {
    if (!initial || !canManage || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const value = await client.disable({
        id: initial.id,
        expectedVersion: initial.version,
      });
      if (alive.current) onSaved(value);
    } catch {
      if (alive.current) setError("saveError");
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  }
  return (
    <article style={styles.card}>
      <h2>{initial?.name ?? t("probes.create")}</h2>
      {initial && (
        <p>
          {t("probes.version")} {initial.version}
          {" · "}
          <time dateTime={initial.updatedAt}>{initial.updatedAt}</time>
        </p>
      )}
      {error && <p role="alert">{t(`probes.${error}`)}</p>}
      <form onSubmit={(event) => void write(event)}>
        <fieldset style={styles.form} disabled={!canManage || saving}>
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
                    .filter((value) => value.enabled)
                    .map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.name}
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
                  {environments.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
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
            />
            {t("probes.enable")}
          </label>
          <label>
            <input
              type="checkbox"
              name="critical"
              checked={critical}
              onChange={(event) => setCritical(event.target.checked)}
            />
            {t("probes.critical")}
          </label>
          <label style={styles.label}>
            {t("probes.url")}
            <input
              style={styles.input}
              type="url"
              name="url"
              required
              maxLength={4096}
              defaultValue={initial?.config.url}
              autoComplete="off"
            />
          </label>
          <label style={styles.label}>
            {t("probes.method")}
            <select
              style={styles.input}
              name="method"
              value={method}
              onChange={(event) =>
                setMethod(event.target.value as "GET" | "HEAD" | "POST")
              }
            >
              <option>GET</option>
              <option>HEAD</option>
              <option>POST</option>
            </select>
          </label>
          <label style={styles.label}>
            {t("probes.interval")}
            <input
              style={styles.input}
              type="number"
              name="interval"
              required
              min={60}
              max={3600}
              defaultValue={initial?.intervalSeconds ?? 60}
            />
          </label>
          {!critical && (
            <label style={styles.label}>
              {t("probes.failures")}
              <input
                style={styles.input}
                type="number"
                name="failures"
                required
                min={1}
                max={10}
                defaultValue={initial?.failureThreshold ?? 2}
              />
            </label>
          )}
          <label style={styles.label}>
            {t("probes.recoveries")}
            <input
              style={styles.input}
              type="number"
              name="recoveries"
              required
              min={1}
              max={10}
              defaultValue={initial?.recoveryThreshold ?? 2}
            />
          </label>
          <label style={styles.label}>
            {t("probes.status")}
            <input
              style={styles.input}
              name="status"
              required
              maxLength={100}
              defaultValue={
                initial?.config.assertions.status.join(", ") ?? "200"
              }
            />
          </label>
          {method !== "HEAD" && (
            <>
              <label style={styles.label}>
                {t("probes.contains")}
                <input
                  style={styles.input}
                  name="contains"
                  maxLength={1000}
                  defaultValue={initial?.config.assertions.contains ?? ""}
                />
              </label>
              <label style={styles.label}>
                {t("probes.json")}
                <textarea
                  style={styles.input}
                  name="json"
                  maxLength={20000}
                  defaultValue={JSON.stringify(
                    initial?.config.assertions.json ?? [],
                  )}
                />
              </label>
              <p>{t("probes.jsonHelp")}</p>
            </>
          )}
          {canManage ? (
            <MonitoringSecretPicker
              key={credentialRevision}
              client={client}
              value={secretId}
              onChange={setSecretId}
              disabled={saving}
              name="authSecretId"
              t={t}
            />
          ) : (
            <label style={styles.label}>
              {t("probes.secret")}
              <input style={styles.input} value={secretId} readOnly />
            </label>
          )}
          <p>{t("probes.secretHelp")}</p>
          <label style={styles.label}>
            {t("probes.timeout")}
            <input
              style={styles.input}
              type="number"
              name="timeout"
              required
              min={100}
              max={10000}
              defaultValue={initial?.config.timeoutMs ?? 5000}
            />
          </label>
          <label style={styles.label}>
            {t("probes.responseLimit")}
            <input
              style={styles.input}
              type="number"
              name="responseLimit"
              required
              min={1}
              max={262144}
              defaultValue={initial?.config.maxResponseBytes ?? 65536}
            />
          </label>
          {method === "POST" && (
            <>
              <p>{t("probes.writeWarning")}</p>
              <label style={styles.label}>
                {t("probes.body")}
                <textarea
                  style={styles.input}
                  name="body"
                  required
                  maxLength={16384}
                  defaultValue={initial?.config.body ?? ""}
                />
              </label>
              <label style={styles.label}>
                {t("probes.markerPath")}
                <input
                  style={styles.input}
                  name="markerPath"
                  required
                  maxLength={2000}
                  defaultValue={JSON.stringify(
                    initial?.config.syntheticWrite?.markerPath ?? ["synthetic"],
                  )}
                />
              </label>
              <label style={styles.label}>
                {t("probes.markerValue")}
                <input
                  style={styles.input}
                  name="markerValue"
                  required
                  maxLength={1100}
                  defaultValue={JSON.stringify(
                    initial?.config.syntheticWrite?.markerValue ?? true,
                  )}
                />
              </label>
              <label style={styles.label}>
                {t("probes.idempotencyHeader")}
                <select
                  style={styles.input}
                  name="idempotencyHeader"
                  defaultValue={
                    initial?.config.syntheticWrite?.idempotencyHeader ??
                    "Idempotency-Key"
                  }
                >
                  <option>Idempotency-Key</option>
                  <option>X-Idempotency-Key</option>
                </select>
              </label>
              <label style={styles.label}>
                {t("probes.cleanup")}
                <textarea
                  style={styles.input}
                  name="cleanup"
                  required
                  maxLength={2000}
                  defaultValue={initial?.config.syntheticWrite?.cleanupGuidance}
                />
              </label>
            </>
          )}
          {canManage && (
            <button style={styles.button} type="submit">
              {saving ? t("probes.saving") : t("probes.save")}
            </button>
          )}
        </fieldset>
      </form>
      {canManage && initial?.enabled && (
        <button
          style={styles.button}
          disabled={saving}
          onClick={() => void disable()}
        >
          {t("probes.disable")}
        </button>
      )}
      {canManage && (
        <MonitoringCredentialForm
          client={client}
          kind="http-probe"
          t={t}
          onCreated={(value) => {
            setSecretId(value.id);
            setCredentialRevision((value) => value + 1);
          }}
        />
      )}
      <p>{t("probes.auditNotice")}</p>
    </article>
  );
}
