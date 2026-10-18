import { useEffect, useRef, useState } from "react";
import type { MonitoringSecretsClient } from "../monitoring-client.js";
import { styles } from "../incidents/styles.js";
/** Render only for authorized administrators. Kept outside the monitor form's save state. */
export function MonitoringSecretPicker({
  client,
  value,
  onChange,
  disabled,
  name,
  t,
}: {
  client: MonitoringSecretsClient;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  name: string;
  t: (key: string) => string;
}) {
  const [items, setItems] = useState<{ id: string; name: string }[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    busy.current = true;
    setLoading(true);
    setError(false);
    setItems([]);
    setNext(null);
    setAvailable(false);
    void client
      .secretOptions({ limit: 25 })
      .then((page) => {
        if (current !== generation.current) return;
        setAvailable(page.available);
        setItems(page.items);
        setNext(page.next);
      })
      .catch(() => {
        if (current === generation.current) setError(true);
      })
      .finally(() => {
        if (current === generation.current) {
          busy.current = false;
          setLoading(false);
        }
      });
    return () => {
      generation.current++;
    };
  }, [client, reload]);
  async function more() {
    if (!next || busy.current) return;
    const current = generation.current;
    busy.current = true;
    setLoading(true);
    setError(false);
    try {
      const page = await client.secretOptions({ limit: 25, after: next });
      if (current !== generation.current) return;
      setAvailable(page.available);
      setNext(page.next);
      setItems((previous) => [
        ...previous,
        ...page.items.filter(
          (item) => !previous.some((old) => old.id === item.id),
        ),
      ]);
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }
  return (
    <section>
      <label style={styles.label}>
        {t("monitoring.credential")}
        <select
          style={styles.input}
          value={value}
          disabled={disabled || loading || !available}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{t("monitoring.noCredential")}</option>
          {value && !items.some((item) => item.id === value) && (
            <option value={value}>
              {t("monitoring.retainedReference")}: {value}
            </option>
          )}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <input type="hidden" name={name} value={value} />
      <p>{t("monitoring.matchingFormat")}</p>
      {loading && <p role="status">{t("settings.loading")}</p>}
      {error && <p role="alert">{t("settings.loadError")}</p>}
      {!loading && !error && !available && (
        <p>{t("settings.credentialsUnavailable")}</p>
      )}
      <button
        type="button"
        style={styles.button}
        disabled={disabled || loading}
        onClick={() => setReload((value) => value + 1)}
      >
        {t("settings.refresh")}
      </button>
      {next && (
        <button
          type="button"
          style={styles.button}
          disabled={disabled || loading}
          onClick={() => void more()}
        >
          {t("monitoring.moreCredentials")}
        </button>
      )}
    </section>
  );
}
