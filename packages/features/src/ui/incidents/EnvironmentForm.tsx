import { useEffect, useRef, useState, type FormEvent } from "react";
import { createEnvironmentInputSchema } from "../../contracts/index.js";
import type { IncidentsClient } from "../incidents-client.js";
import { styles } from "./styles.js";
export function EnvironmentForm({
  client,
  t,
}: {
  client: IncidentsClient;
  t: (key: string) => string;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<"saved" | "error">();
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [client]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const current = generation.current;
    const form = event.currentTarget;
    const data = new FormData(form);
    busy.current = true;
    setPending(true);
    setResult(undefined);
    try {
      await client.createEnvironment(
        createEnvironmentInputSchema.parse({
          name: data.get("name"),
          key: data.get("key"),
          isProduction: data.get("isProduction") === "on",
        }),
      );
      if (current === generation.current) {
        form.reset();
        setResult("saved");
      }
    } catch {
      if (current === generation.current) setResult("error");
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  return (
    <details style={styles.card}>
      <summary>{t("incidents.createEnvironment")}</summary>
      {result && (
        <p role={result === "error" ? "alert" : "status"}>
          {t(
            result === "error"
              ? "incidents.error"
              : "incidents.environmentSaved",
          )}
        </p>
      )}
      <form onSubmit={(event) => void create(event)}>
        <fieldset disabled={pending} style={styles.form}>
          <label style={styles.label}>
            {t("incidents.environmentName")}
            <input style={styles.input} name="name" required maxLength={200} />
          </label>
          <label style={styles.label}>
            {t("incidents.environmentKey")}
            <input style={styles.input} name="key" required maxLength={80} />
          </label>
          <label>
            <input name="isProduction" type="checkbox" />
            {t("incidents.production")}
          </label>
          <button style={styles.button} type="submit">
            {t(pending ? "incidents.saving" : "incidents.createEnvironment")}
          </button>
        </fieldset>
      </form>
    </details>
  );
}
