import { useEffect, useRef, useState } from "react";
import {
  writeContactSchema,
  type ConfiguredContact,
  type Responder,
  type WriteContactInput,
} from "../../contracts/index.js";
import type { PagingSettingsClient } from "../settings-client.js";
import { styles } from "../incidents/styles.js";
export function ContactEditor({
  initial,
  responders,
  secrets,
  client,
  onSaved,
  onCancel,
  t,
}: {
  initial?: ConfiguredContact;
  responders: Responder[];
  secrets: { id: string; name: string }[];
  client: Pick<PagingSettingsClient, "writeContact">;
  onSaved: () => void;
  onCancel: () => void;
  t: (key: string) => string;
}) {
  const [draft, setDraft] = useState<WriteContactInput>(() =>
    initial
      ? {
          id: initial.id,
          responderId: initial.responderId,
          channel: initial.channel,
          secretId: initial.secretId,
          enabled: initial.enabled,
          priority: initial.priority,
          expectedVersion: initial.version,
        }
      : {
          id: crypto.randomUUID(),
          responderId: responders.find((person) => person.enabled)?.id ?? "",
          channel: "pushover",
          secretId: "",
          enabled: true,
          priority: 0,
          expectedVersion: null,
        },
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
    if (busy.current) return;
    const current = generation.current;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      await client.writeContact(writeContactSchema.parse(draft));
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
        <fieldset disabled={pending} style={styles.form}>
          <legend>{t("settings.contact")}</legend>
          <label style={styles.label}>
            {t("settings.responder")}
            <select
              required
              style={styles.input}
              value={draft.responderId}
              disabled={Boolean(initial)}
              onChange={(event) =>
                setDraft({ ...draft, responderId: event.target.value })
              }
            >
              <option value="">{t("settings.chooseResponder")}</option>
              {draft.responderId &&
                !responders.some(
                  (person) => person.id === draft.responderId,
                ) && (
                  <option value={draft.responderId}>{draft.responderId}</option>
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
          <label style={styles.label}>
            {t("settings.channel")}
            <select
              style={styles.input}
              value={draft.channel}
              onChange={(event) => {
                const channel = event.target.value;
                if (channel === "pushover" || channel === "webhook")
                  setDraft({ ...draft, channel });
              }}
            >
              <option value="pushover">Pushover</option>
              <option value="webhook">Webhook</option>
              {!["pushover", "webhook"].includes(draft.channel) && (
                <option value={draft.channel}>{draft.channel}</option>
              )}
            </select>
          </label>
          <label style={styles.label}>
            {t("settings.credentialLabel")}
            <select
              required
              style={styles.input}
              value={draft.secretId}
              onChange={(event) =>
                setDraft({ ...draft, secretId: event.target.value })
              }
            >
              <option value="">{t("settings.chooseCredential")}</option>
              {draft.secretId &&
                !secrets.some((secret) => secret.id === draft.secretId) && (
                  <option value={draft.secretId}>
                    {t("settings.unlistedCredential")}
                  </option>
                )}
              {secrets.map((secret) => (
                <option key={secret.id} value={secret.id}>
                  {secret.name}
                </option>
              ))}
            </select>
          </label>
          <label style={styles.label}>
            {t("settings.priority")}
            <input
              style={styles.input}
              required
              type="number"
              min={0}
              max={1000}
              value={draft.priority}
              onChange={(event) =>
                setDraft({ ...draft, priority: Number(event.target.value) })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) =>
                setDraft({ ...draft, enabled: event.target.checked })
              }
            />
            {t("settings.enabled")}
          </label>
          <button style={styles.button} type="submit">
            {t("settings.save")}
          </button>
        </fieldset>
      </form>
      <button
        type="button"
        style={styles.button}
        disabled={pending}
        onClick={onCancel}
      >
        {t("settings.discard")}
      </button>
      {pending && <p role="status">{t("settings.saving")}</p>}
      {error && <p role="alert">{t("settings.saveError")}</p>}
    </section>
  );
}
