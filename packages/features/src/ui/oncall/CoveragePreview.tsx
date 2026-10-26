import { useEffect, useRef, useState } from "react";
import type { Responder, Schedule } from "../../contracts/index.js";
import type { OnCallClient, ScheduleCoverage } from "../oncall-client.js";
import { styles } from "../incidents/styles.js";
export function CoveragePreview({
  client,
  schedule,
  responders,
  canManage,
  t,
}: {
  client: OnCallClient;
  schedule: Schedule;
  responders: Responder[];
  canManage: boolean;
  t: (key: string) => string;
}) {
  const [start, setStart] = useState(() =>
    new Date().toISOString().slice(0, 16),
  );
  const [end, setEnd] = useState(() =>
    new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16),
  );
  const [coverage, setCoverage] = useState<ScheduleCoverage>();
  const [saved, setSaved] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const responderName = (responderId: string) =>
    responders.find((person) => person.id === responderId)?.displayName ??
    responderId;
  useEffect(() => {
    generation.current++;
    busy.current = false;
    setPending(false);
    setCoverage(undefined);
    setSaved(undefined);
    setError(false);
    return () => {
      generation.current++;
    };
  }, [client, schedule.id, schedule.version]);
  async function load(persist: boolean) {
    if (busy.current || (persist && !canManage)) return;
    const current = generation.current;
    busy.current = true;
    setPending(true);
    setError(false);
    setSaved(undefined);
    try {
      const input = {
        scheduleId: schedule.id,
        startsAt: new Date(start + "Z").toISOString(),
        endsAt: new Date(end + "Z").toISOString(),
      };
      const result = persist
        ? await client
            .preview(input)
            .then((coverage) => ({ coverage, id: coverage.id }))
        : await client
            .coverage(input)
            .then((coverage) => ({ coverage, id: undefined }));
      if (current !== generation.current) return;
      setCoverage(result.coverage);
      setSaved(result.id);
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  function change(value: string, setter: (value: string) => void) {
    setter(value);
    setCoverage(undefined);
    setSaved(undefined);
    setError(false);
  }
  return (
    <section aria-label={t("oncall.coverage")} aria-busy={pending}>
      <h3>{t("oncall.coverage")}</h3>
      <p>{t("oncall.previewRange")}</p>
      <label style={styles.label}>
        {t("oncall.startsUtc")}
        <input
          style={styles.input}
          type="datetime-local"
          value={start}
          disabled={pending}
          onChange={(e) => change(e.target.value, setStart)}
        />
      </label>
      <label style={styles.label}>
        {t("oncall.endsUtc")}
        <input
          style={styles.input}
          type="datetime-local"
          value={end}
          disabled={pending}
          onChange={(e) => change(e.target.value, setEnd)}
        />
      </label>
      <button
        style={styles.button}
        disabled={pending || !start || !end}
        onClick={() => void load(false)}
      >
        {t("oncall.preview")}
      </button>
      {canManage && (
        <button
          style={styles.button}
          disabled={pending || !start || !end}
          onClick={() => void load(true)}
        >
          {t("oncall.savePreview")}
        </button>
      )}
      {pending && <p role="status">{t("oncall.loading")}</p>}
      {error && <p role="alert">{t("oncall.error")}</p>}
      {saved && (
        <p role="status">
          {t("oncall.savedPreview")}: <code>{saved}</code>
        </p>
      )}
      {coverage && (
        <>
          <p>
            {t("oncall.version")}: {coverage.scheduleVersion}
          </p>
          {coverage.intervals.some((row) => row.assignment === null) && (
            <p role="status">{t("oncall.gaps")}</p>
          )}
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th style={styles.cell} scope="col">
                    {t("oncall.startsUtc")}
                  </th>
                  <th style={styles.cell} scope="col">
                    {t("oncall.endsUtc")}
                  </th>
                  <th style={styles.cell} scope="col">
                    {t("oncall.responder")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {coverage.intervals.map((row) => (
                  <tr key={row.startsAt}>
                    <td style={styles.cell}>
                      <time dateTime={row.startsAt}>{row.startsAt}</time>
                    </td>
                    <td style={styles.cell}>
                      <time dateTime={row.endsAt}>{row.endsAt}</time>
                    </td>
                    <td style={styles.cell}>
                      {row.assignment
                        ? responderName(row.assignment.responderId)
                        : t("oncall.uncovered")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
