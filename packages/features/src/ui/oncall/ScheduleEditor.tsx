import { useEffect, useRef, useState } from "react";
import {
  writeScheduleSchema,
  responderIdSchema,
  type Schedule,
  type Service,
  type Responder,
} from "../../contracts/index.js";
import type { OnCallClient } from "../oncall-client.js";
import { styles } from "../incidents/styles.js";
import { RotationEditor } from "./RotationEditor.js";
import { OverrideEditor } from "./OverrideEditor.js";
import { CoveragePreview } from "./CoveragePreview.js";
type Draft = Pick<Schedule, "name" | "enabled" | "rotations" | "overrides"> & {
  id: string;
  serviceId: string;
  expectedVersion: number | null;
};
function fromSchedule(value: Schedule): Draft {
  return {
    id: value.id,
    serviceId: value.serviceId,
    name: value.name,
    enabled: value.enabled,
    rotations: structuredClone(value.rotations),
    overrides: structuredClone(value.overrides),
    expectedVersion: value.version,
  };
}
export function ScheduleEditor({
  initial,
  services,
  responders,
  client,
  canManage,
  onSaved,
  t,
}: {
  initial?: Schedule;
  services: Service[];
  responders: Responder[];
  client: OnCallClient;
  canManage: boolean;
  onSaved: (value: Schedule) => void;
  t: (key: string) => string;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() =>
    initial
      ? fromSchedule(initial)
      : {
          id: crypto.randomUUID(),
          serviceId: services.find((service) => service.enabled)?.id ?? "",
          name: "",
          enabled: true,
          rotations: [],
          overrides: [],
          expectedVersion: null,
        },
  );
  const [dirty, setDirty] = useState(!initial);
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
  function change(next: Draft) {
    setDraft(next);
    setDirty(true);
    setError(false);
  }
  async function run(save: boolean) {
    if (busy.current || (save && !canManage)) return;
    const current = generation.current;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const value = save
        ? await client.writeSchedule(writeScheduleSchema.parse(draft))
        : await client.schedule({ id: draft.id });
      if (current === generation.current) {
        setDraft(fromSchedule(value));
        setSnapshot(value);
        setDirty(false);
        onSaved(value);
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
  return (
    <section
      style={styles.card}
      aria-busy={pending}
      aria-label={t("oncall.editSchedule")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(true);
        }}
      >
        <fieldset disabled={pending || !canManage}>
          <legend>{t("oncall.schedule")}</legend>
          <label style={styles.label}>
            {t("oncall.name")}
            <input
              style={styles.input}
              required
              maxLength={200}
              value={draft.name}
              onChange={(e) => change({ ...draft, name: e.target.value })}
            />
          </label>
          <label style={styles.label}>
            {t("oncall.service")}
            <select
              style={styles.input}
              required
              disabled={snapshot !== undefined}
              value={draft.serviceId}
              onChange={(e) => change({ ...draft, serviceId: e.target.value })}
            >
              <option value="">{t("oncall.chooseService")}</option>
              {draft.serviceId &&
                !services.some((service) => service.id === draft.serviceId) && (
                  <option value={draft.serviceId}>{draft.serviceId}</option>
                )}
              {services.map((service) => (
                <option
                  key={service.id}
                  value={service.id}
                  disabled={!service.enabled}
                >
                  {service.name}
                </option>
              ))}
            </select>
          </label>
          <label style={styles.label}>
            <input
              style={styles.input}
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => change({ ...draft, enabled: e.target.checked })}
            />
            {t("oncall.enabled")}
          </label>
          {draft.rotations.map((rotation, index) => (
            <RotationEditor
              key={rotation.id}
              value={rotation}
              responders={responders}
              disabled={pending || !canManage}
              t={t}
              onChange={(value) =>
                change({
                  ...draft,
                  rotations: draft.rotations.map((row, i) =>
                    i === index ? value : row,
                  ),
                })
              }
              onRemove={() =>
                change({
                  ...draft,
                  rotations: draft.rotations.filter((_, i) => i !== index),
                })
              }
            />
          ))}
          <button
            type="button"
            style={styles.button}
            disabled={draft.rotations.length >= 50}
            onClick={() =>
              change({
                ...draft,
                rotations: [
                  ...draft.rotations,
                  {
                    id: crypto.randomUUID(),
                    timeZone: "UTC",
                    anchorLocal: new Date().toISOString().slice(0, 16),
                    shiftDays: 7,
                    priority: 0,
                    disambiguation: "compatible",
                    until: null,
                    responders: [],
                  },
                ],
              })
            }
          >
            {t("oncall.addRotation")}
          </button>
          {draft.overrides.map((override, index) => (
            <OverrideEditor
              key={override.id}
              value={override}
              responders={responders}
              disabled={pending || !canManage}
              t={t}
              onChange={(value) =>
                change({
                  ...draft,
                  overrides: draft.overrides.map((row, i) =>
                    i === index ? value : row,
                  ),
                })
              }
              onRemove={() =>
                change({
                  ...draft,
                  overrides: draft.overrides.filter((_, i) => i !== index),
                })
              }
            />
          ))}
          <button
            type="button"
            style={styles.button}
            disabled={
              draft.overrides.length >= 200 ||
              !responders.some((person) => person.enabled)
            }
            onClick={() => {
              const person = responders.find((person) => person.enabled);
              if (person)
                change({
                  ...draft,
                  overrides: [
                    ...draft.overrides,
                    {
                      id: crypto.randomUUID(),
                      responderId: responderIdSchema.parse(person.id),
                      startsAt: new Date().toISOString(),
                      endsAt: new Date(Date.now() + 3600000).toISOString(),
                      approved: false,
                    },
                  ],
                });
            }}
          >
            {t("oncall.addOverride")}
          </button>
          {canManage && (
            <button type="submit" style={styles.button} disabled={!dirty}>
              {t("oncall.save")}
            </button>
          )}
        </fieldset>
      </form>
      {pending && <p role="status">{t("oncall.loading")}</p>}
      {error && <p role="alert">{t("oncall.saveError")}</p>}
      {(snapshot || error) && (
        <button
          type="button"
          style={styles.button}
          disabled={pending}
          onClick={() => void run(false)}
        >
          {dirty ? t("oncall.discardReload") : t("oncall.reload")}
        </button>
      )}
      {dirty && <p>{t("oncall.saveBeforePreview")}</p>}
      {snapshot && !dirty && (
        <CoveragePreview
          client={client}
          schedule={snapshot}
          responders={responders}
          canManage={canManage}
          t={t}
        />
      )}
    </section>
  );
}
