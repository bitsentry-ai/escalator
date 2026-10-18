import { useEffect, useRef, useState } from "react";
import {
  writeDetectionBindingSchema,
  type DetectionBindingKey,
  type ServiceEnvironment,
} from "../../contracts/index.js";
import type { DetectionClient } from "../detection-client.js";
import { useIncidentCollection as useCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
export function DetectionBindingEditor({
  client,
  serviceId,
  environmentId,
  canManage,
  t,
}: DetectionBindingKey & {
  client: DetectionClient;
  canManage: boolean;
  t: (key: string) => string;
}) {
  const policies = useCollection(client.policies);
  const [binding, setBinding] = useState<ServiceEnvironment>();
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [policyId, setPolicyId] = useState("");
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    busy.current = false;
    setPending(false);
    setLoaded(false);
    setError(false);
    setBinding(undefined);
    setEnabled(false);
    setPolicyId("");
    void client
      .binding({ serviceId, environmentId })
      .then((value) => {
        if (current !== generation.current) return;
        setBinding(value);
        setEnabled(value?.enabled ?? false);
        setPolicyId(value?.policyId ?? "");
        setLoaded(true);
      })
      .catch(() => {
        if (current === generation.current) setError(true);
      });
    return () => {
      generation.current++;
    };
  }, [client, serviceId, environmentId, reload]);
  async function save() {
    if (!canManage || !loaded || busy.current) return;
    const current = generation.current;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const value = await client.configureBinding(
        writeDetectionBindingSchema.parse({
          serviceId,
          environmentId,
          expectedVersion: binding?.version ?? null,
          enabled,
          policyId: policyId || null,
        }),
      );
      if (current === generation.current) {
        setBinding(value);
        setEnabled(value.enabled);
        setPolicyId(value.policyId ?? "");
      }
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  const options = policies.items.filter(
    (policy) => policy.serviceId === serviceId,
  );
  return (
    <section style={styles.card} aria-label={t("detection.heading")}>
      <h3>{t("detection.heading")}</h3>
      <p>{t("detection.help")}</p>
      {((!loaded && !error) || policies.loading || pending) && (
        <p role="status">{t("settings.loading")}</p>
      )}
      {(error || policies.error) && <p role="alert">{t("detection.error")}</p>}
      <button
        style={styles.button}
        disabled={pending}
        onClick={() => {
          setReload((value) => value + 1);
          policies.refresh();
        }}
      >
        {t("settings.refresh")}
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset
          style={styles.form}
          disabled={!canManage || !loaded || pending}
        >
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />{" "}
            {t("detection.enabled")}
          </label>
          <label style={styles.label}>
            {t("detection.policy")}
            <select
              style={styles.input}
              value={policyId}
              required={enabled}
              onChange={(event) => setPolicyId(event.target.value)}
            >
              <option value="">{t("detection.none")}</option>
              {policyId &&
                !options.some((policy) => policy.id === policyId) && (
                  <option value={policyId}>
                    {t("monitoring.retainedReference")}: {policyId}
                  </option>
                )}
              {options.map((policy) => (
                <option
                  key={policy.id}
                  value={policy.id}
                  disabled={!policy.enabled}
                >
                  {policy.id} · {t("probes.version")} {policy.version}
                </option>
              ))}
            </select>
          </label>
          {canManage && (
            <button type="submit" style={styles.button}>
              {t("detection.save")}
            </button>
          )}
        </fieldset>
      </form>
      {policies.next && (
        <button
          style={styles.button}
          disabled={policies.loading || pending}
          onClick={() => void policies.more()}
        >
          {t("detection.more")}
        </button>
      )}
      {binding && (
        <p>
          {t("probes.version")} {binding.version}
        </p>
      )}
      <p>{t("detection.audit")}</p>
    </section>
  );
}
