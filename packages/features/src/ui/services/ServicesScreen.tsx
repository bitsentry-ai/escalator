import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from "react";
import type { Service } from "../../contracts/index.js";
import type { ServicesClient } from "../services-client.js";
const styles = {
  form: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit,minmax(10rem,1fr))",
    gap: 12,
    alignItems: "end",
  },
  label: { display: "grid", gap: 6 },
  input: {
    padding: 8,
    border: "1px solid #64748b",
    borderRadius: 6,
    minWidth: 0,
    background: "transparent",
    color: "inherit",
    font: "inherit",
  },
  button: {
    padding: "8px 12px",
    border: "1px solid #0f766e",
    borderRadius: 6,
    background: "#0f766e",
    color: "white",
    font: "inherit",
  },
  cell: {
    textAlign: "left",
    padding: "10px 8px",
    borderBottom: "1px solid #94a3b844",
  },
} satisfies Record<string, CSSProperties>;
export interface ServicesScreenProps {
  client: ServicesClient;
  canCreate: boolean;
  t: (key: string) => string;
}
/** Shared screen; each host supplies identity, translated labels and its tRPC client. */
export function ServicesScreen({ client, canCreate, t }: ServicesScreenProps) {
  const [items, setItems] = useState<Service[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const [reload, setReload] = useState(0);
  // Retry keeps unsaved form input; hosts remount via key on identity/workspace change.
  useEffect(() => {
    const current = ++generation.current;
    setItems([]);
    setLoading(true);
    setSaving(false);
    setError(false);
    setNext(null);
    void client
      .listServices({ limit: 25 })
      .then((page) => {
        if (current === generation.current) {
          setItems(page.items);
          setNext(page.next);
        }
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
  }, [client, reload]);
  async function loadMore() {
    if (!next || loading || saving) return;
    const current = generation.current;
    setLoading(true);
    setError(false);
    try {
      const page = await client.listServices({ limit: 25, after: next });
      if (current === generation.current) {
        setItems((previous) => [
          ...previous,
          ...page.items.filter(
            (item) => !previous.some((existing) => existing.id === item.id),
          ),
        ]);
        setNext(page.next);
      }
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loading || !canCreate) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const current = generation.current;
    setSaving(true);
    setError(false);
    try {
      const service = await client.createService({
        name: String(values.get("name") ?? ""),
        key: String(values.get("key") ?? ""),
        owningTeam: String(values.get("owningTeam") ?? ""),
      });
      if (current === generation.current) {
        setItems((previous) => [
          service,
          ...previous.filter((item) => item.id !== service.id),
        ]);
        form.reset();
      }
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setSaving(false);
    }
  }
  return (
    <section aria-labelledby="escalator-services-title">
      <h2 id="escalator-services-title">{t("services.title")}</h2>
      {error && (
        <div role="alert">
          <p>{t("services.error")}</p>
          <button
            style={styles.button}
            type="button"
            onClick={() => setReload((value) => value + 1)}
          >
            {t("services.retry")}
          </button>
        </div>
      )}
      {canCreate && (
        <form style={styles.form} onSubmit={(event) => void create(event)}>
          <label style={styles.label}>
            {t("services.name")}
            <input style={styles.input} name="name" required maxLength={200} />
          </label>
          <label style={styles.label}>
            {t("services.key")}
            <input
              style={styles.input}
              name="key"
              required
              maxLength={80}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label style={styles.label}>
            {t("services.team")}
            <input
              style={styles.input}
              name="owningTeam"
              required
              maxLength={200}
            />
          </label>
          <button
            style={styles.button}
            type="submit"
            disabled={saving || loading}
          >
            {saving ? t("services.saving") : t("services.create")}
          </button>
        </form>
      )}
      {loading && <p role="status">{t("services.loading")}</p>}
      {!loading && !items.length && !error && <p>{t("services.empty")}</p>}
      {!!items.length && (
        <table
          style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}
        >
          <thead>
            <tr>
              <th style={styles.cell} scope="col">
                {t("services.name")}
              </th>
              <th style={styles.cell} scope="col">
                {t("services.key")}
              </th>
              <th style={styles.cell} scope="col">
                {t("services.team")}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((service) => (
              <tr key={service.id}>
                <td style={styles.cell}>{service.name}</td>
                <td style={styles.cell}>{service.key}</td>
                <td style={styles.cell}>{service.owningTeam}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && (
        <button
          style={styles.button}
          type="button"
          disabled={loading || saving}
          onClick={() => void loadMore()}
        >
          {t("services.more")}
        </button>
      )}
    </section>
  );
}
