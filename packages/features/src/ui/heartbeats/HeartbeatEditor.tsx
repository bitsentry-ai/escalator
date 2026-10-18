import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Heartbeat, Service, Environment } from "../../contracts/index.js";
import type { HeartbeatsClient } from "../heartbeats-client.js";
import { styles } from "../incidents/styles.js";
import { readHeartbeatForm } from "./form.js";
export function HeartbeatEditor({
  client,
  initial,
  services,
  environments,
  canManage,
  onSaved,
  t,
}: {
  client: HeartbeatsClient;
  initial?: Heartbeat;
  services: Service[];
  environments: Environment[];
  canManage: boolean;
  onSaved: (value: Heartbeat) => void;
  t: (key: string) => string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || busy.current) return;
    const data = new FormData(event.currentTarget);
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const command = readHeartbeatForm(data, initial);
      const result =
        command.kind === "create"
          ? await client.create(command.input)
          : await client.update(command.input);
      if (alive.current) onSaved(result);
    } catch {
      if (alive.current) setError(true);
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  async function disable() {
    if (!canManage || !initial || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const result = await client.disable({
        id: initial.id,
        expectedVersion: initial.version,
      });
      if (alive.current) onSaved(result);
    } catch {
      if (alive.current) setError(true);
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  return (
    <article style={styles.card}>
      <h2>{initial?.name ?? t("heartbeats.create")}</h2>
      {error && <p role="alert">{t("sources.error")}</p>}
      <form onSubmit={(event) => void save(event)}>
        <fieldset style={styles.form} disabled={!canManage || pending}>
          <label style={styles.label}>
            {t("probes.name")}
            <input
              style={styles.input}
              name="name"
              required
              maxLength={200}
              defaultValue={initial?.name}
            />
          </label>
          {!initial && (
            <>
              <label style={styles.label}>
                {t("probes.service")}
                <select
                  style={styles.input}
                  name="service"
                  required
                  defaultValue=""
                >
                  <option value="">{t("probes.choose")}</option>
                  {services
                    .filter((service) => service.enabled)
                    .map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                </select>
              </label>
              <label style={styles.label}>
                {t("probes.environment")}
                <select
                  style={styles.input}
                  name="environment"
                  required
                  defaultValue=""
                >
                  <option value="">{t("probes.choose")}</option>
                  {environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={initial?.enabled ?? false}
            />{" "}
            {t("probes.enabled")}
          </label>
          <label style={styles.label}>
            {t("heartbeats.interval")}
            <input
              style={styles.input}
              name="interval"
              type="number"
              min={60}
              max={86400}
              step={1}
              required
              defaultValue={initial?.intervalSeconds ?? 60}
            />
          </label>
          <label style={styles.label}>
            {t("heartbeats.grace")}
            <input
              style={styles.input}
              name="grace"
              type="number"
              min={0}
              max={3600}
              step={1}
              required
              defaultValue={initial?.graceSeconds ?? 10}
            />
          </label>
          {canManage && (
            <button type="submit" style={styles.button}>
              {t("heartbeats.save")}
            </button>
          )}
        </fieldset>
      </form>
      {initial && (
        <p>
          {t("probes.version")} {initial.version}
        </p>
      )}
      {canManage && initial?.enabled && (
        <button
          style={styles.button}
          disabled={pending}
          onClick={() => void disable()}
        >
          {t("probes.disable")}
        </button>
      )}
      {pending && <p role="status">{t("settings.saving")}</p>}
      <p>{t("heartbeats.audit")}</p>
    </article>
  );
}
