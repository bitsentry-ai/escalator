import { ModelCredentialForm } from "./ModelCredentialForm.js";
import { useEffect, useRef, useState } from "react";
import type { InvestigationSettings } from "../../contracts/index.js";
import type { InvestigationSettingsClient } from "../investigation-settings-client.js";
import {
  investigationForm,
  investigationInput,
  type InvestigationForm,
} from "./form.js";
import { SourceSelection } from "./SourceSelection.js";
import { styles } from "../incidents/styles.js";
export function SettingsEditor({
  client,
  scope,
  initial,
  canManage,
  onSaved,
  t,
}: {
  client: InvestigationSettingsClient;
  scope: { serviceId: string; environmentId: string };
  initial?: InvestigationSettings;
  canManage: boolean;
  onSaved: () => void;
  t: (key: string) => string;
}) {
  const [form, setForm] = useState(() => investigationForm(initial));
  const [pending, setPending] = useState(false),
    [error, setError] = useState(false);
  const generation = useRef(0),
    busy = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [client],
  );
  const change = <K extends keyof InvestigationForm>(
    key: K,
    value: InvestigationForm[K],
  ) => setForm((previous) => ({ ...previous, [key]: value }));
  async function save() {
    if (!canManage || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(false);
    const current = generation.current;
    try {
      const request = investigationInput(form, scope, initial);
      if (request.kind === "create") await client.create(request.input);
      else await client.update(request.input);
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
    <section>
      {canManage && client.createSecret && (
        <ModelCredentialForm
          create={client.createSecret}
          onCreated={(id) => change("secretId", id)}
          t={t}
        />
      )}
      <form
        style={styles.card}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p>{t("investigationSettings.destinationGuidance")}</p>
        <p>{t("investigationSettings.activationGuidance")}</p>
        {initial && (
          <p>
            {t("investigationSettings.revision")}: {initial.profile.revision}
          </p>
        )}
        {error && <p role="alert">{t("investigationSettings.saveError")}</p>}
        <fieldset disabled={pending || !canManage} style={styles.form}>
          <legend>{t("investigationSettings.model")}</legend>
          <label>
            {t("investigationSettings.provider")}{" "}
            <select
              value={form.provider}
              onChange={(e) =>
                change(
                  "provider",
                  e.target.value as InvestigationForm["provider"],
                )
              }
            >
              {[
                "ollama",
                "openai",
                "anthropic",
                "gemini",
                "groq",
                "kilocode",
                "openrouter",
              ].map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("investigationSettings.location")}{" "}
            <select
              value={form.location}
              onChange={(e) =>
                change(
                  "location",
                  e.target.value as InvestigationForm["location"],
                )
              }
            >
              <option value="local">{t("investigationSettings.local")}</option>
              <option value="remote">
                {t("investigationSettings.remote")}
              </option>
            </select>
          </label>
          <label>
            {t("investigationSettings.model")}{" "}
            <input
              required
              maxLength={200}
              value={form.model}
              onChange={(e) => change("model", e.target.value)}
            />
          </label>
          <label>
            {t("investigationSettings.endpoint")}{" "}
            <input
              required
              type="url"
              maxLength={4096}
              value={form.endpoint}
              onChange={(e) => change("endpoint", e.target.value)}
            />
          </label>
          <label>
            {t("investigationSettings.secretId")}{" "}
            <input
              autoComplete="off"
              maxLength={200}
              value={form.secretId}
              onChange={(e) => change("secretId", e.target.value)}
            />
          </label>
          <p>{t("investigationSettings.secretGuidance")}</p>
          <label>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => change("enabled", e.target.checked)}
            />
            {t("investigationSettings.enabled")}
          </label>
          <label>
            {t("investigationSettings.duration")}{" "}
            <input
              type="number"
              required
              min={1}
              max={600}
              step={1}
              value={form.durationSeconds}
              onChange={(e) => change("durationSeconds", e.target.value)}
            />
          </label>
          <label>
            {t("investigationSettings.reads")}{" "}
            <input
              type="number"
              required
              min={1}
              max={32}
              step={1}
              value={form.evidenceReads}
              onChange={(e) => change("evidenceReads", e.target.value)}
            />
          </label>
          <label>
            {t("investigationSettings.bytes")}{" "}
            <input
              type="number"
              required
              min={1}
              max={256}
              step="any"
              value={form.evidenceKiB}
              onChange={(e) => change("evidenceKiB", e.target.value)}
            />
          </label>
          <label>
            {t("investigationSettings.tokens")}{" "}
            <input
              type="number"
              required
              min={128}
              max={16384}
              step={1}
              value={form.outputTokens}
              onChange={(e) => change("outputTokens", e.target.value)}
            />
          </label>
          <SourceSelection
            client={client}
            scope={scope}
            value={form.sources}
            onChange={(sources) => change("sources", sources)}
            t={t}
          />
          {canManage && (
            <button type="submit" style={styles.button}>
              {t("investigationSettings.save")}
            </button>
          )}
        </fieldset>
      </form>
    </section>
  );
}
