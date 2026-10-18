import type { Responder, ScheduleOverride } from "../../contracts/index.js";
import { styles } from "../incidents/styles.js";
export function OverrideEditor({
  value,
  responders,
  disabled,
  onChange,
  onRemove,
  t,
}: {
  value: ScheduleOverride;
  responders: Responder[];
  disabled: boolean;
  onChange: (value: ScheduleOverride) => void;
  onRemove: () => void;
  t: (key: string) => string;
}) {
  const toUtc = (value: string) =>
    value ? new Date(value + "Z").toISOString() : "";
  return (
    <fieldset disabled={disabled} style={styles.card}>
      <legend>{t("oncall.override")}</legend>
      <label>
        {t("oncall.responder")}
        <select
          value={value.responderId}
          onChange={(e) => {
            const person = responders.find(
              (person) => person.id === e.target.value && person.enabled,
            );
            if (person) onChange({ ...value, responderId: person.id });
          }}
        >
          {!responders.some((person) => person.id === value.responderId) && (
            <option value={value.responderId}>{value.responderId}</option>
          )}
          {responders.map((person) => (
            <option
              key={person.id}
              value={person.id}
              disabled={!person.enabled}
            >
              {person.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("oncall.startsUtc")}
        <input
          required
          type="datetime-local"
          value={value.startsAt.slice(0, 16)}
          onChange={(e) =>
            onChange({ ...value, startsAt: toUtc(e.target.value) })
          }
        />
      </label>
      <label>
        {t("oncall.endsUtc")}
        <input
          required
          type="datetime-local"
          value={value.endsAt.slice(0, 16)}
          onChange={(e) =>
            onChange({ ...value, endsAt: toUtc(e.target.value) })
          }
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={value.approved}
          onChange={(e) => onChange({ ...value, approved: e.target.checked })}
        />
        {t("oncall.approved")}
      </label>
      <button type="button" style={styles.button} onClick={onRemove}>
        {t("oncall.removeOverride")}
      </button>
    </fieldset>
  );
}
