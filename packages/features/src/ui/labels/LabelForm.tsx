import { useEffect, useRef, useState } from "react";
import {
  incidentLabelInputSchema,
  type IncidentLabel,
  type OperationalIncident,
} from "../../contracts/index.js";
import type { LabelsClient } from "./client.js";
import { styles } from "../incidents/styles.js";
type Scope = {
  serviceId: string;
  environmentId: string;
  stream: { kind: "metric" | "probe" | "signal"; id: string };
};
export function LabelForm({
  client,
  scope,
  incident,
  value,
  onSaved,
  t,
}: {
  client: LabelsClient;
  scope: Scope;
  incident?: OperationalIncident;
  value?: IncidentLabel;
  onSaved: (value: IncidentLabel) => void;
  t: (key: string) => string;
}) {
  const [summary, setSummary] = useState(value?.summary ?? "");
  const [start, setStart] = useState(
    (value?.startedAt ?? incident?.openedAt ?? "").replace(/Z$/, ""),
  );
  const [end, setEnd] = useState(
    (
      value?.endedAt ??
      (incident ? (incident.resolvedAt ?? new Date().toISOString()) : "")
    ).replace(/Z$/, ""),
  );
  const [outcome, setOutcome] = useState<"actionable" | "noise">(
    value?.outcome ?? "actionable",
  );
  const [pending, setPending] = useState(false),
    [error, setError] = useState(false);
  const busy = useRef(false),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const incidentId = value ? value.incidentId : (incident?.id ?? null);
  async function save() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const input = incidentLabelInputSchema.parse({
        ...scope,
        incidentId,
        origin: incidentId === null ? "missed_incident" : "incident_review",
        summary,
        outcome,
        startedAt: new Date(start + "Z").toISOString(),
        endedAt: new Date(end + "Z").toISOString(),
      });
      const saved = value
        ? await client.edit({
            id: value.id,
            expectedRevision: value.revision,
            input,
          })
        : await client.create(input);
      if (active.current) onSaved(saved);
    } catch {
      if (active.current) setError(true);
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      style={styles.card}
    >
      <h3>
        {value
          ? t("labels.edit")
          : incidentId === null
            ? t("labels.missed")
            : t("labels.incidentReview")}
      </h3>
      <fieldset disabled={pending} style={styles.form}>
        <label style={styles.label}>
          {t("labels.startedAt")}
          <input
            required
            type="datetime-local"
            step="0.001"
            value={start}
            onChange={(event) => setStart(event.target.value)}
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          {t("labels.endedAt")}
          <input
            required
            type="datetime-local"
            step="0.001"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            style={styles.input}
          />
        </label>
        <p>{t("labels.timeHelp")}</p>
        {incidentId !== null && (
          <label style={styles.label}>
            {t("labels.outcome")}
            <select
              value={outcome}
              onChange={(event) =>
                setOutcome(event.target.value as "actionable" | "noise")
              }
              style={styles.input}
            >
              <option value="actionable">{t("labels.actionable")}</option>
              <option value="noise">{t("labels.noise")}</option>
            </select>
          </label>
        )}
        <label style={styles.label}>
          {t("labels.summary")}
          <textarea
            required
            maxLength={2000}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            style={styles.input}
          />
        </label>
        <button type="submit" style={styles.button}>
          {t("labels.saveDraft")}
        </button>
      </fieldset>
      {error && <p role="alert">{t("labels.saveError")}</p>}
    </form>
  );
}
