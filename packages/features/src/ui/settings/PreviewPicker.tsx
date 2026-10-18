import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConfigurationPageInput,
  Schedule,
  SchedulePreview,
} from "../../contracts/index.js";
import type { PagingSettingsClient } from "../settings-client.js";
import { useIncidentCollection as useCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
export function PreviewPicker({
  schedule,
  value,
  reviewed,
  onChange,
  onReviewedChange,
  client,
  label,
  t,
}: {
  schedule?: Schedule;
  value: string | null;
  reviewed: boolean;
  onChange: (id: string | null) => void;
  onReviewedChange: (value: boolean) => void;
  client: Pick<PagingSettingsClient, "previews" | "storedPreview">;
  label: string;
  t: (key: string) => string;
}) {
  const query = useCallback(
    (input: ConfigurationPageInput) =>
      schedule
        ? client.previews({
            ...input,
            limit: Math.min(input.limit ?? 5, 5),
            scheduleId: schedule.id,
          })
        : Promise.resolve({ items: [], next: null }),
    [client, schedule?.id, schedule?.version],
  );
  const pages = useCollection(query);
  const [selected, setSelected] = useState<SchedulePreview>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setSelected(undefined);
    setError(false);
    setLoading(Boolean(value));
    onReviewedChange(false);
    if (value)
      void client
        .storedPreview({ id: value })
        .then((result) => {
          if (current === generation.current) setSelected(result);
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
  }, [client, value, schedule?.id, schedule?.version, onReviewedChange]);
  const current = Boolean(
    selected &&
    schedule &&
    selected.scheduleId === schedule.id &&
    selected.serviceId === schedule.serviceId &&
    selected.scheduleVersion === schedule.version,
  );
  const gaps =
    selected?.intervals.filter((interval) => interval.assignment === null) ??
    [];
  const description = (preview: SchedulePreview) =>
    `${preview.startsAt} – ${preview.endsAt} · v${preview.scheduleVersion}`;
  return (
    <section style={styles.card} aria-label={label}>
      <label style={styles.label}>
        {label}
        <select
          style={styles.input}
          disabled={!schedule}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">{t("policy.choosePreview")}</option>
          {value && !pages.items.some((item) => item.id === value) && (
            <option value={value}>
              {selected ? description(selected) : t("policy.selectedPreview")}
            </option>
          )}
          {pages.items.map((preview) => (
            <option
              key={preview.id}
              value={preview.id}
              disabled={preview.scheduleVersion !== schedule?.version}
            >
              {description(preview)}
            </option>
          ))}
        </select>
      </label>
      {(loading || pages.loading) && (
        <p role="status">{t("settings.loading")}</p>
      )}
      {(error || pages.error) && <p role="alert">{t("settings.loadError")}</p>}
      <button
        style={styles.button}
        type="button"
        disabled={pages.loading}
        onClick={pages.refresh}
      >
        {t("policy.refreshPreviews")}
      </button>
      {pages.next && (
        <button
          style={styles.button}
          type="button"
          disabled={pages.loading}
          onClick={() => void pages.more()}
        >
          {t("policy.morePreviews")}
        </button>
      )}
      {!pages.loading && !pages.items.length && <p>{t("policy.noPreviews")}</p>}
      {selected && !current && <p role="alert">{t("policy.stalePreview")}</p>}
      {selected && current && (
        <>
          <p>{description(selected)}</p>
          <p>{gaps.length ? t("oncall.gaps") : t("policy.noGaps")}</p>
          {gaps.length > 0 && (
            <ul>
              {gaps.map((gap) => (
                <li key={gap.startsAt}>
                  <time dateTime={gap.startsAt}>{gap.startsAt}</time> –{" "}
                  <time dateTime={gap.endsAt}>{gap.endsAt}</time>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <label>
        <input
          type="checkbox"
          disabled={!current}
          checked={reviewed && current}
          onChange={(event) => onReviewedChange(event.target.checked)}
        />
        {t("policy.reviewed")}
      </label>
    </section>
  );
}
