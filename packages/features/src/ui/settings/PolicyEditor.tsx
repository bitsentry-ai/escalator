import { useEffect, useRef, useState } from "react";
import {
  defaultEscalationSteps,
  writePolicySchema,
  type ConfiguredPolicy,
  type WritePolicyInput,
  type Service,
  type Schedule,
  type Responder,
} from "../../contracts/index.js";
import type { PagingSettingsClient } from "../settings-client.js";
import { styles } from "../incidents/styles.js";
import { PreviewPicker } from "./PreviewPicker.js";
import { RecipientPicker } from "./RecipientPicker.js";
export function PolicyEditor({
  initial,
  services,
  schedules,
  responders,
  client,
  canManage,
  onSaved,
  onCancel,
  t,
}: {
  canManage: boolean;
  initial?: ConfiguredPolicy;
  services: Service[];
  schedules: Schedule[];
  responders: Responder[];
  client: PagingSettingsClient;
  onSaved: () => void;
  onCancel: () => void;
  t: (key: string) => string;
}) {
  const [draft, setDraft] = useState<Omit<WritePolicyInput, "terminal">>(() =>
    initial
      ? {
          id: initial.id,
          serviceId: initial.serviceId,
          primaryScheduleId: initial.primaryScheduleId,
          peerScheduleId: initial.peerScheduleId,
          fallbackResponderIds: [...initial.fallbackResponderIds],
          steps: structuredClone(initial.steps),
          enabled: initial.enabled,
          primaryPreviewId: initial.primaryPreviewId,
          peerPreviewId: initial.peerPreviewId,
          expectedVersion: initial.version,
        }
      : {
          id: crypto.randomUUID(),
          serviceId: "",
          primaryScheduleId: "",
          peerScheduleId: "",
          fallbackResponderIds: [],
          steps: defaultEscalationSteps(),
          enabled: false,
          primaryPreviewId: null,
          peerPreviewId: null,
          expectedVersion: null,
        },
  );
  const [reminderMinutes, setReminderMinutes] = useState(
    initial ? String(initial.terminal.reminderIntervalMs / 60000) : "",
  );
  const [reminders, setReminders] = useState(
    initial ? String(initial.terminal.maxReminders) : "",
  );
  const [operators, setOperators] = useState<string[]>(
    initial ? [...initial.terminal.notifyResponderIds] : [],
  );
  const [primaryReviewed, setPrimaryReviewed] = useState(false);
  const [peerReviewed, setPeerReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
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
    if (draft.enabled && (!primaryReviewed || !peerReviewed)) {
      setError("policy.reviewRequired");
      return;
    }
    const current = generation.current;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const input = writePolicySchema.parse({
        ...draft,
        terminal: {
          action: "notify_operator",
          reminderIntervalMs: Number(reminderMinutes) * 60000,
          maxReminders: Number(reminders),
          notifyResponderIds: operators,
        },
      });
      await client.writePolicy(input);
      if (current === generation.current) onSaved();
    } catch {
      if (current === generation.current) setError("settings.saveError");
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  const choices = schedules.filter(
    (schedule) => schedule.serviceId === draft.serviceId,
  );
  return (
    <section style={styles.card}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={pending || !canManage} style={styles.form}>
          <legend>{t("policy.heading")}</legend>
          <label style={styles.label}>
            {t("oncall.service")}
            <select
              style={styles.input}
              required
              disabled={Boolean(initial)}
              value={draft.serviceId}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  serviceId: event.target.value,
                  primaryScheduleId: "",
                  peerScheduleId: "",
                  primaryPreviewId: null,
                  peerPreviewId: null,
                })
              }
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
          {(["primary", "peer"] as const).map((target) => {
            const scheduleKey =
              target === "primary" ? "primaryScheduleId" : "peerScheduleId";
            const previewKey =
              target === "primary" ? "primaryPreviewId" : "peerPreviewId";
            return (
              <label key={target} style={styles.label}>
                {t(`policy.${target}Schedule`)}
                <select
                  style={styles.input}
                  required
                  value={draft[scheduleKey]}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      [scheduleKey]: event.target.value,
                      [previewKey]: null,
                    })
                  }
                >
                  <option value="">{t("policy.chooseSchedule")}</option>
                  {draft[scheduleKey] &&
                    !choices.some(
                      (schedule) => schedule.id === draft[scheduleKey],
                    ) && (
                      <option value={draft[scheduleKey]}>
                        {draft[scheduleKey]}
                      </option>
                    )}
                  {choices.map((schedule) => (
                    <option
                      key={schedule.id}
                      value={schedule.id}
                      disabled={!schedule.enabled}
                    >
                      {schedule.name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          <PreviewPicker
            schedule={choices.find((row) => row.id === draft.primaryScheduleId)}
            value={draft.primaryPreviewId}
            reviewed={primaryReviewed}
            onReviewedChange={setPrimaryReviewed}
            onChange={(value) =>
              setDraft({ ...draft, primaryPreviewId: value })
            }
            client={client}
            label={t("policy.primaryPreview")}
            t={t}
          />
          <PreviewPicker
            schedule={choices.find((row) => row.id === draft.peerScheduleId)}
            value={draft.peerPreviewId}
            reviewed={peerReviewed}
            onReviewedChange={setPeerReviewed}
            onChange={(value) => setDraft({ ...draft, peerPreviewId: value })}
            client={client}
            label={t("policy.peerPreview")}
            t={t}
          />
          <RecipientPicker
            label={t("policy.fallback")}
            responders={responders}
            selected={draft.fallbackResponderIds}
            onChange={(values) =>
              setDraft({ ...draft, fallbackResponderIds: values })
            }
            t={t}
          />
          <fieldset style={styles.card}>
            <legend>{t("policy.ladder")}</legend>
            {draft.steps.map((step, index) => (
              <div key={step.id} style={styles.card}>
                <label style={styles.label}>
                  {t("policy.offset")}
                  <input
                    style={styles.input}
                    required
                    type="number"
                    min={0}
                    max={10080}
                    step="any"
                    value={step.offsetMs / 60000}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        steps: draft.steps.map((row, i) =>
                          i === index
                            ? {
                                ...row,
                                offsetMs: Number(event.target.value) * 60000,
                              }
                            : row,
                        ),
                      })
                    }
                  />
                </label>
                <label style={styles.label}>
                  {t("policy.target")}
                  <select
                    style={styles.input}
                    value={step.target}
                    onChange={(event) => {
                      const target = event.target.value;
                      if (
                        target === "primary" ||
                        target === "peer" ||
                        target === "fallback"
                      )
                        setDraft({
                          ...draft,
                          steps: draft.steps.map((row, i) =>
                            i === index ? { ...row, target } : row,
                          ),
                        });
                    }}
                  >
                    {["primary", "peer", "fallback"].map((target) => (
                      <option key={target} value={target}>
                        {t(`policy.targets.${target}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  style={styles.button}
                  type="button"
                  disabled={draft.steps.length === 1}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      // The ladder must still start when the page opens.
                      steps: draft.steps
                        .filter((_, i) => i !== index)
                        .map((row, i) =>
                          i === 0 && index === 0
                            ? { ...row, offsetMs: 0 }
                            : row,
                        ),
                    })
                  }
                >
                  {t("policy.removeStep")}
                </button>
              </div>
            ))}
            <button
              style={styles.button}
              type="button"
              disabled={
                draft.steps.length >= 20 ||
                (draft.steps.at(-1)?.offsetMs ?? 0) >= 604800000
              }
              onClick={() =>
                setDraft({
                  ...draft,
                  steps: [
                    ...draft.steps,
                    {
                      id: crypto.randomUUID(),
                      offsetMs: Math.min(
                        604800000,
                        (draft.steps.at(-1)?.offsetMs ?? 0) + 60000,
                      ),
                      target: "fallback",
                    },
                  ],
                })
              }
            >
              {t("policy.addStep")}
            </button>
          </fieldset>
          <p>{t("policy.terminalHelp")}</p>
          <label style={styles.label}>
            {t("policy.reminderMinutes")}
            <input
              style={styles.input}
              required
              type="number"
              min={1}
              max={1440}
              step="any"
              value={reminderMinutes}
              onChange={(event) => setReminderMinutes(event.target.value)}
            />
          </label>
          <label style={styles.label}>
            {t("policy.maxReminders")}
            <input
              style={styles.input}
              required
              type="number"
              min={1}
              max={100}
              value={reminders}
              onChange={(event) => setReminders(event.target.value)}
            />
          </label>
          <RecipientPicker
            label={t("policy.operators")}
            responders={responders}
            selected={operators}
            onChange={setOperators}
            t={t}
          />
          <label>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) =>
                setDraft({ ...draft, enabled: event.target.checked })
              }
            />
            {t("policy.enable")}
          </label>
          {canManage && (
            <button style={styles.button} type="submit">
              {t("policy.save")}
            </button>
          )}
        </fieldset>
      </form>
      <button
        style={styles.button}
        type="button"
        disabled={pending}
        onClick={onCancel}
      >
        {t(canManage ? "settings.discard" : "settings.close")}
      </button>
      {pending && <p role="status">{t("settings.saving")}</p>}
      {error && <p role="alert">{t(error)}</p>}
    </section>
  );
}
