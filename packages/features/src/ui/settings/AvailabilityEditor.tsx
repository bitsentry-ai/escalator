import { useEffect, useRef, useState } from "react";
import {
  writeAvailabilitySchema,
  type Availability,
  type Responder,
} from "../../contracts/index.js";
import type { PagingSettingsClient } from "../settings-client.js";
import { styles } from "../incidents/styles.js";
const time = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const minute = (value: string) => {
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$/.test(value)) return NaN;
  const [hour, minutes] = value.split(":").map(Number);
  return hour * 60 + minutes;
};
export function AvailabilityEditor({
  initial,
  responders,
  client,
  canManage,
  onSaved,
  onCancel,
  t,
}: {
  canManage: boolean;
  initial?: Availability;
  responders: Responder[];
  client: Pick<PagingSettingsClient, "writeAvailability">;
  onSaved: () => void;
  onCancel: () => void;
  t: (key: string) => string;
}) {
  const [person, setPerson] = useState<string>(initial?.id ?? "");
  const [zone, setZone] = useState(initial?.timeZone ?? "UTC");
  const [windows, setWindows] = useState(() =>
    (initial?.windows ?? []).map((window) => ({
      key: crypto.randomUUID(),
      weekdays: [...window.weekdays],
      start: time(window.startMinute),
      end: time(window.endMinute),
    })),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function save() {
    if (busy.current || !canManage) return;
    const current = generation.current;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      await client.writeAvailability(
        writeAvailabilitySchema.parse({
          id: person,
          timeZone: zone,
          expectedVersion: initial?.version ?? null,
          windows: windows.map((window) => ({
            weekdays: window.weekdays,
            startMinute: minute(window.start),
            endMinute: minute(window.end),
          })),
        }),
      );
      if (current === generation.current) onSaved();
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  return (
    <section style={styles.card}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={pending || !canManage} style={styles.form}>
          <legend>{t("availability.heading")}</legend>
          <p>{t("availability.help")}</p>
          <label style={styles.label}>
            {t("settings.responder")}
            <select
              style={styles.input}
              required
              disabled={Boolean(initial)}
              value={person}
              onChange={(event) => {
                const value = responders.find(
                  (row) => row.id === event.target.value,
                );
                setPerson(event.target.value);
                if (value) setZone(value.timeZone);
              }}
            >
              <option value="">{t("settings.chooseResponder")}</option>
              {person && !responders.some((row) => row.id === person) && (
                <option value={person}>{person}</option>
              )}
              {responders.map((row) => (
                <option key={row.id} value={row.id} disabled={!row.enabled}>
                  {row.displayName}
                </option>
              ))}
            </select>
          </label>
          <label style={styles.label}>
            {t("oncall.timeZone")}
            <input
              style={styles.input}
              required
              value={zone}
              onChange={(event) => setZone(event.target.value)}
            />
          </label>
          {!windows.length && <p>{t("availability.noWindows")}</p>}
          {windows.map((window, index) => (
            <fieldset key={window.key} style={styles.card}>
              <legend>
                {t("availability.window")} {index + 1}
              </legend>
              {["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(
                (day, dayIndex) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={window.weekdays.includes(dayIndex + 1)}
                      onChange={(event) =>
                        setWindows(
                          windows.map((row) =>
                            row.key === window.key
                              ? {
                                  ...row,
                                  weekdays: event.target.checked
                                    ? [...row.weekdays, dayIndex + 1].sort()
                                    : row.weekdays.filter(
                                        (value) => value !== dayIndex + 1,
                                      ),
                                }
                              : row,
                          ),
                        )
                      }
                    />
                    {t(`availability.days.${day}`)}
                  </label>
                ),
              )}
              <label style={styles.label}>
                {t("availability.start")}
                <input
                  style={styles.input}
                  required
                  inputMode="numeric"
                  placeholder="HH:MM"
                  pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]"
                  value={window.start}
                  onChange={(event) =>
                    setWindows(
                      windows.map((row) =>
                        row.key === window.key
                          ? { ...row, start: event.target.value }
                          : row,
                      ),
                    )
                  }
                />
              </label>
              <label style={styles.label}>
                {t("availability.end")}
                <input
                  style={styles.input}
                  required
                  inputMode="numeric"
                  placeholder="HH:MM"
                  pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00"
                  value={window.end}
                  onChange={(event) =>
                    setWindows(
                      windows.map((row) =>
                        row.key === window.key
                          ? { ...row, end: event.target.value }
                          : row,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                style={styles.button}
                onClick={() =>
                  setWindows(windows.filter((row) => row.key !== window.key))
                }
              >
                {t("availability.remove")}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            style={styles.button}
            disabled={windows.length >= 28}
            onClick={() =>
              setWindows([
                ...windows,
                {
                  key: crypto.randomUUID(),
                  weekdays: [1, 2, 3, 4, 5],
                  start: "09:00",
                  end: "17:00",
                },
              ])
            }
          >
            {t("availability.add")}
          </button>
          {canManage && (
            <button style={styles.button} type="submit">
              {t("availability.save")}
            </button>
          )}
        </fieldset>
      </form>
      <button
        type="button"
        style={styles.button}
        disabled={pending}
        onClick={onCancel}
      >
        {t(canManage ? "settings.discard" : "settings.close")}
      </button>
      {pending && <p role="status">{t("settings.saving")}</p>}
      {error && <p role="alert">{t("settings.saveError")}</p>}
    </section>
  );
}
