import type { IncidentPageInput } from "../../contracts/index.js";
import type { IncidentCollection } from "../incidents-client.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
export function Choice({
  fetch,
  label,
  value,
  onChange,
  t,
}: {
  fetch: (
    page: IncidentPageInput,
  ) => Promise<
    IncidentCollection<{ id: string; name: string; enabled?: boolean }>
  >;
  label: string;
  value: string;
  onChange: (value: string) => void;
  t: (key: string) => string;
}) {
  const list = useIncidentCollection(fetch);
  return (
    <div>
      <label style={styles.label}>
        {label}
        <select
          style={styles.input}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={list.loading || list.error}
        >
          <option value="">{t("deployments.choose")}</option>
          {list.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.enabled === false ? ` (${t("labels.disabled")})` : ""}
            </option>
          ))}
        </select>
      </label>
      {list.loading && <p role="status">{t("sources.loading")}</p>}
      {list.error && <p role="alert">{t("labels.loadError")}</p>}
      {list.error && (
        <button type="button" onClick={list.refresh}>
          {t("sources.refresh")}
        </button>
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
