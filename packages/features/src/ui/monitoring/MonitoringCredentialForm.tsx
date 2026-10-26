import { useLayoutEffect, useRef, useState } from "react";
import {
  createMonitoringSecretSchema,
  type MonitoringSecretKind,
} from "../../contracts/index.js";
import type { MonitoringSecretsClient } from "../monitoring-client.js";
import { styles } from "../incidents/styles.js";
export function MonitoringCredentialForm({
  client,
  kind,
  onCreated,
  t,
}: {
  client: MonitoringSecretsClient;
  kind: MonitoringSecretKind;
  onCreated: (value: { id: string; name: string }) => void;
  t: (key: string) => string;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [header, setHeader] = useState<"authorization" | "x-api-key">(
    "authorization",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  useLayoutEffect(() => {
    generation.current++;
    busy.current = false;
    setName("");
    setValue("");
    setError(false);
    setPending(false);
    setHeader("authorization");
    return () => {
      generation.current++;
    };
  }, [client, kind]);
  async function create() {
    if (!client.createMonitoringSecret || busy.current) return;
    const current = generation.current;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      let credentials: Record<string, string> = { key: value };
      if (kind === "http-probe") credentials = { header, value };
      else if (kind === "metrics") credentials = { authorization: value };
      const result = await client.createMonitoringSecret(
        createMonitoringSecretSchema.parse({ name, kind, credentials }),
      );
      if (current === generation.current) {
        setName("");
        setValue("");
        onCreated(result);
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
  if (!client.createMonitoringSecret)
    return <p>{t("monitoring.externalCredentials")}</p>;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
      style={styles.card}
    >
      <fieldset disabled={pending} style={styles.form}>
        <legend>{t("monitoring.newCredential")}</legend>
        <p>{t("monitoring.writeOnly")}</p>
        <label style={styles.label}>
          {t("settings.name")}
          <input
            style={styles.input}
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {kind === "http-probe" && (
          <label style={styles.label}>
            {t("monitoring.header")}
            <select
              style={styles.input}
              value={header}
              onChange={(event) => {
                if (
                  event.target.value === "authorization" ||
                  event.target.value === "x-api-key"
                )
                  setHeader(event.target.value);
              }}
            >
              <option value="authorization">Authorization</option>
              <option value="x-api-key">X-API-Key</option>
            </select>
          </label>
        )}
        <label style={styles.label}>
          {t(
            kind === "provider-signing"
              ? "monitoring.signingKey"
              : "monitoring.headerValue",
          )}
          <input
            style={styles.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={kind === "provider-signing" ? 4096 : 8192}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <button style={styles.button} type="submit">
          {t("settings.createCredential")}
        </button>
      </fieldset>
      {pending && <p role="status">{t("settings.saving")}</p>}
      {error && <p role="alert">{t("settings.credentialError")}</p>}
    </form>
  );
}
