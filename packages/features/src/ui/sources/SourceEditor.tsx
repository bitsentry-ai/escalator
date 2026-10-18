import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  needsManualProviderRecovery,
  usesProviderSignature,
  type SignalSource,
  type Service,
  type Environment,
} from "../../contracts/index.js";
import type { SourcesClient } from "../sources-client.js";
import { MonitoringSecretPicker } from "../monitoring/MonitoringSecretPicker.js";
import { MonitoringCredentialForm } from "../monitoring/MonitoringCredentialForm.js";
import { styles } from "../incidents/styles.js";
import { readSourceForm, readProviderForm } from "./form.js";
export function SourceEditor({
  client,
  initial,
  services,
  environments,
  canManage,
  onSaved,
  t,
}: {
  client: SourcesClient;
  initial?: SignalSource;
  services: Service[];
  environments: Environment[];
  canManage: boolean;
  onSaved: (source: SignalSource) => void;
  t: (key: string) => string;
}) {
  const [mode, setMode] = useState("generic");
  const [secret, setSecret] = useState(initial?.authSecretId ?? "");
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
  const managed =
    initial && ["probe", "heartbeat", "metrics"].includes(initial.kind);
  const signed = initial?.intake
    ? usesProviderSignature(initial.intake)
    : mode === "sentry-hmac" || mode === "grafana-hmac";
  const manual = initial?.intake
    ? needsManualProviderRecovery(initial.intake)
    : mode === "sentry-hmac" || mode === "glitchtip";
  async function save(event: FormEvent<HTMLFormElement>, provider = false) {
    event.preventDefault();
    if (!canManage || managed || busy.current) return;
    const form = new FormData(event.currentTarget);
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      let result: SignalSource;
      if (provider && initial)
        result = await client.updateProvider(readProviderForm(form, initial));
      else {
        const command = readSourceForm(form, initial);
        result =
          command.kind === "update"
            ? await client.update(command.input)
            : command.kind === "generic"
              ? await client.create(command.input)
              : await client.createProvider(command.input);
      }
      if (alive.current) onSaved(result);
    } catch {
      if (alive.current) setError(true);
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  if (managed) return <p>{t("sources.managed")}</p>;
  const credential = canManage ? (
    <MonitoringSecretPicker
      key={revision}
      client={client}
      name="authSecretId"
      value={secret}
      onChange={setSecret}
      disabled={pending}
      t={t}
    />
  ) : (
    <p>
      {t("monitoring.retainedReference")}: {secret}
    </p>
  );
  return (
    <article style={styles.card}>
      <h2>{initial?.name ?? t("sources.create")}</h2>
      {initial && (
        <p>
          {t("probes.version")} {initial.version} · {initial.kind}
        </p>
      )}
      {error && <p role="alert">{t("sources.error")}</p>}
      <form onSubmit={(event) => void save(event)}>
        <fieldset disabled={!canManage || pending} style={styles.form}>
          <label style={styles.label}>
            {t("sources.name")}
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
              <label style={styles.label}>
                {t("sources.mode")}
                <select
                  style={styles.input}
                  name="mode"
                  value={mode}
                  onChange={(event) => {
                    setMode(event.target.value);
                    setSecret("");
                  }}
                >
                  <option value="generic">{t("sources.generic")}</option>
                  <option value="sentry-hmac">Sentry HMAC</option>
                  <option value="glitchtip">GlitchTip</option>
                  <option value="grafana-bearer">Grafana Bearer</option>
                  <option value="grafana-hmac">Grafana HMAC</option>
                </select>
              </label>
              {mode === "glitchtip" && (
                <label style={styles.label}>
                  {t("sources.origin")}
                  <input
                    style={styles.input}
                    name="origin"
                    type="url"
                    required
                    maxLength={2048}
                  />
                </label>
              )}
              {signed && credential}
            </>
          )}
          <label style={styles.label}>
            {t("sources.grouping")}
            <select
              style={styles.input}
              name="grouping"
              defaultValue={initial?.grouping ?? "source-fingerprint"}
            >
              <option value="source-fingerprint">
                {t("sources.byFingerprint")}
              </option>
              <option value="fingerprint">{t("sources.acrossSources")}</option>
            </select>
          </label>
          <label style={styles.label}>
            {t("sources.recovery")}
            <select
              style={styles.input}
              name="recovery"
              defaultValue={
                manual ? "manual" : (initial?.recovery ?? "explicit")
              }
            >
              {!manual && (
                <option value="explicit">{t("sources.explicit")}</option>
              )}
              <option value="manual">{t("sources.manual")}</option>
            </select>
          </label>
          {manual && <p>{t("sources.manualHelp")}</p>}
          <label style={styles.label}>
            {t("sources.hold")}
            <input
              style={styles.input}
              name="hold"
              type="number"
              min={0}
              max={86400}
              step={1}
              required
              defaultValue={initial?.recoveryHoldSeconds ?? 60}
            />
          </label>
          {initial && (
            <label>
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={initial.enabled}
              />{" "}
              {t("probes.enabled")}
            </label>
          )}
          {canManage && (
            <button type="submit" style={styles.button}>
              {t("sources.save")}
            </button>
          )}
        </fieldset>
      </form>
      {initial?.intake && (
        <form onSubmit={(event) => void save(event, true)}>
          <fieldset disabled={!canManage || pending} style={styles.form}>
            <legend>{t("sources.providerConfig")}</legend>
            {initial.intake.mode === "glitchtip" && (
              <label style={styles.label}>
                {t("sources.origin")}
                <input
                  style={styles.input}
                  name="origin"
                  type="url"
                  required
                  maxLength={2048}
                  defaultValue={initial.intake.trackerOrigin}
                />
              </label>
            )}
            {signed && credential}
            {canManage && (signed || initial.intake.mode === "glitchtip") && (
              <button style={styles.button} type="submit">
                {t("sources.saveProvider")}
              </button>
            )}
          </fieldset>
        </form>
      )}
      {canManage && signed && (
        <MonitoringCredentialForm
          client={client}
          kind="provider-signing"
          t={t}
          onCreated={(value) => {
            setSecret(value.id);
            setRevision((value) => value + 1);
          }}
        />
      )}
      {pending && <p role="status">{t("settings.saving")}</p>}
      <p>{t("sources.audit")}</p>
    </article>
  );
}
