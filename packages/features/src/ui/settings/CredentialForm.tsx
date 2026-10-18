import { useLayoutEffect, useRef, useState } from "react";
import { createChannelSecretSchema } from "../../contracts/index.js";
import type { PagingSettingsClient } from "../settings-client.js";
import { styles } from "../incidents/styles.js";
export function CredentialForm({
  client,
  onCreated,
  t,
}: {
  client: Pick<PagingSettingsClient, "createSecret">;
  onCreated: (value: { id: string; name: string }) => void;
  t: (key: string) => string;
}) {
  const [channel, setChannel] = useState<"pushover" | "webhook">("pushover");
  const [name, setName] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  // Clear a changed client before paint; initial passive effects must not erase input.
  useLayoutEffect(() => {
    generation.current++;
    busy.current = false;
    setPending(false);
    setFields({});
    setName("");
    setError(false);
    return () => {
      generation.current++;
    };
  }, [client]);
  async function create() {
    if (!client.createSecret || busy.current) return;
    const current = generation.current;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const credentials =
        channel === "pushover"
          ? {
              token: fields.token ?? "",
              user: fields.user ?? "",
              ...(fields.device ? { device: fields.device } : {}),
            }
          : {
              url: fields.url ?? "",
              ...(fields.bearerToken
                ? { bearerToken: fields.bearerToken }
                : {}),
            };
      const result = await client.createSecret(
        createChannelSecretSchema.parse({ channel, name, credentials }),
      );
      if (current === generation.current) {
        setFields({});
        setName("");
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
  if (!client.createSecret) return <p>{t("settings.externalCredentials")}</p>;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
      style={styles.card}
    >
      <fieldset disabled={pending} style={styles.form}>
        <legend>{t("settings.newCredential")}</legend>
        <p>{t("settings.writeOnly")}</p>
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
        <label style={styles.label}>
          {t("settings.channel")}
          <select
            style={styles.input}
            value={channel}
            onChange={(event) => {
              setChannel(
                event.target.value === "webhook" ? "webhook" : "pushover",
              );
              setFields({});
              setError(false);
            }}
          >
            <option value="pushover">Pushover</option>
            <option value="webhook">Webhook</option>
          </select>
        </label>
        {(channel === "pushover"
          ? ["token", "user", "device"]
          : ["url", "bearerToken"]
        ).map((field) => (
          <label key={field} style={styles.label}>
            {t(`settings.credential.${field}`)}
            <input
              style={styles.input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              required={["token", "user", "url"].includes(field)}
              maxLength={4096}
              value={fields[field] ?? ""}
              onChange={(event) =>
                setFields({ ...fields, [field]: event.target.value })
              }
            />
          </label>
        ))}
        <button style={styles.button} type="submit">
          {t("settings.createCredential")}
        </button>
      </fieldset>
      {pending && <p role="status">{t("settings.saving")}</p>}
      {error && <p role="alert">{t("settings.credentialError")}</p>}
    </form>
  );
}
