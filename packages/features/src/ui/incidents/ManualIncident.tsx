import { styles } from "./styles.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { manualIncidentInputSchema } from "../../contracts/index.js";
import type { IncidentsClient } from "../incidents-client.js";
import { useIncidentCollection } from "./useIncidentCollection.js";
export function ManualIncident({
  client,
  onCreated,
  t,
}: {
  client: IncidentsClient;
  onCreated: (id: string) => void;
  t: (key: string) => string;
}) {
  const services = useIncidentCollection(client.services);
  const environments = useIncidentCollection(client.environments);
  const policies = useIncidentCollection(client.policies);
  const [service, setService] = useState("");
  const [policy, setPolicy] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const request = useRef<{ fingerprint: string; id: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    const current = ++generation.current;
    return () => {
      if (generation.current === current) generation.current++;
    };
  }, [client]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const current = generation.current;
    busy.current = true;
    setSaving(true);
    setError(false);
    try {
      const payload = {
        serviceId: fields.get("serviceId"),
        environmentId: fields.get("environmentId"),
        policyId: fields.get("policyId"),
        title: fields.get("title"),
        severity: fields.get("severity"),
      };
      const fingerprint = JSON.stringify(payload);
      if (request.current?.fingerprint !== fingerprint)
        request.current = {
          fingerprint,
          id: Array.from(
            globalThis.crypto.getRandomValues(new Uint8Array(16)),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join(""),
        };
      const result = await client.create(
        manualIncidentInputSchema.parse({
          ...payload,
          requestId: request.current.id,
        }),
      );
      if (current === generation.current) {
        request.current = undefined;
        form.reset();
        setService("");
        setPolicy("");
        onCreated(result.incidentId);
      }
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setSaving(false);
      }
    }
  }
  return (
    <section style={styles.card} aria-label={t("incidents.create")}>
      <h2>{t("incidents.create")}</h2>
      <p>{t("incidents.configurationHelp")}</p>
      {(error || services.error || environments.error || policies.error) && (
        <p role="alert">{t("incidents.error")}</p>
      )}
      <form onSubmit={(event) => void create(event)}>
        <fieldset style={styles.form} disabled={saving}>
          <label style={styles.label}>
            {t("incidents.title")}
            <input style={styles.input} name="title" required maxLength={500} />
          </label>
          <label style={styles.label}>
            {t("incidents.service")}
            <select
              style={styles.input}
              name="serviceId"
              required
              value={service}
              onChange={(event) => {
                setService(event.target.value);
                setPolicy("");
              }}
            >
              <option value="">{t("incidents.choose")}</option>
              {services.items
                .filter((item) => item.enabled)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            style={styles.button}
            type="button"
            disabled={services.loading}
            onClick={() =>
              void (services.next ? services.more() : services.refresh())
            }
          >
            {t(
              services.next
                ? "incidents.moreServices"
                : "incidents.refreshServices",
            )}
          </button>
          <label style={styles.label}>
            {t("incidents.environment")}
            <select
              style={styles.input}
              name="environmentId"
              required
              defaultValue=""
            >
              <option value="">{t("incidents.choose")}</option>
              {environments.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            style={styles.button}
            type="button"
            disabled={environments.loading}
            onClick={() =>
              void (environments.next
                ? environments.more()
                : environments.refresh())
            }
          >
            {t(
              environments.next
                ? "incidents.moreEnvironments"
                : "incidents.refreshEnvironments",
            )}
          </button>
          <label style={styles.label}>
            {t("incidents.policy")}
            <select
              style={styles.input}
              name="policyId"
              required
              value={policy}
              onChange={(event) => setPolicy(event.target.value)}
            >
              <option value="">{t("incidents.choose")}</option>
              {policies.items
                .filter((item) => item.enabled && item.serviceId === service)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} (v{item.version})
                  </option>
                ))}
            </select>
          </label>
          <button
            style={styles.button}
            type="button"
            disabled={policies.loading}
            onClick={() =>
              void (policies.next ? policies.more() : policies.refresh())
            }
          >
            {t(
              policies.next
                ? "incidents.morePolicies"
                : "incidents.refreshPolicies",
            )}
          </button>
          <label style={styles.label}>
            {t("incidents.severity")}
            <select style={styles.input} name="severity" defaultValue="high">
              {(["warning", "high", "critical"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`incidents.severities.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <button style={styles.button} type="submit">
            {t(saving ? "incidents.saving" : "incidents.create")}
          </button>
        </fieldset>
      </form>
    </section>
  );
}
