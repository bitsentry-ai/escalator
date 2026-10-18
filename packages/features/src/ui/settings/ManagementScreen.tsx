import { useEffect, useRef, useState } from "react";
import type {
  Availability,
  ConfiguredPolicy,
  Schedule,
} from "../../contracts/index.js";
import type { PagingSettingsClient } from "../settings-client.js";
import { useIncidentCollection as useCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
import { PolicyEditor } from "./PolicyEditor.js";
import { AvailabilityEditor } from "./AvailabilityEditor.js";
export function ManagementScreen({
  mode,
  client,
  canManage,
  t,
}: {
  mode: "policies" | "availability";
  client: PagingSettingsClient;
  canManage: boolean;
  t: (key: string) => string;
}) {
  const policies = useCollection(client.policies);
  const availability = useCollection(client.availability);
  const services = useCollection(client.services);
  const schedules = useCollection(client.schedules);
  const responders = useCollection(client.responders);
  const [policy, setPolicy] = useState<ConfiguredPolicy | null>();
  const [hours, setHours] = useState<Availability | null>();
  const [freshSchedules, setFreshSchedules] = useState<Schedule[]>([]);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setPolicy(undefined);
    setHours(undefined);
    setFreshSchedules([]);
    setOpening(false);
    setOpenError(false);
    return () => {
      generation.current++;
    };
  }, [client, mode]);
  const loading =
    policies.loading ||
    availability.loading ||
    services.loading ||
    schedules.loading ||
    responders.loading;
  const error =
    policies.error ||
    availability.error ||
    services.error ||
    schedules.error ||
    responders.error ||
    openError;
  async function open(id: string) {
    const current = ++generation.current;
    setOpening(true);
    setOpenError(false);
    setPolicy(undefined);
    try {
      const value = await client.policy({ id });
      const rows = await Promise.all(
        [...new Set([value.primaryScheduleId, value.peerScheduleId])].map(
          (id) => client.schedule({ id }),
        ),
      );
      if (current === generation.current) {
        setFreshSchedules(rows);
        setPolicy(value);
      }
    } catch {
      if (current === generation.current) setOpenError(true);
    } finally {
      if (current === generation.current) setOpening(false);
    }
  }
  const scheduleOptions = [
    ...freshSchedules,
    ...schedules.items.filter(
      (row) => !freshSchedules.some((fresh) => fresh.id === row.id),
    ),
  ];
  return (
    <section>
      <h1>
        {t(mode === "policies" ? "policy.heading" : "availability.heading")}
      </h1>
      {(loading || opening) && <p role="status">{t("settings.loading")}</p>}
      {error && <p role="alert">{t("settings.loadError")}</p>}
      <button
        style={styles.button}
        disabled={loading || opening}
        onClick={() => {
          policies.refresh();
          availability.refresh();
          services.refresh();
          schedules.refresh();
          responders.refresh();
        }}
      >
        {t("settings.refresh")}
      </button>
      {canManage && (
        <button
          style={styles.button}
          disabled={loading || opening}
          onClick={() => {
            if (mode === "policies") {
              setPolicy(null);
              setFreshSchedules([]);
            } else setHours(null);
          }}
        >
          {t(mode === "policies" ? "policy.create" : "availability.create")}
        </button>
      )}
      {mode === "policies" ? (
        <>
          {!loading && !policies.items.length && <p>{t("policy.empty")}</p>}
          <ul>
            {policies.items.map((row) => (
              <li key={row.id}>
                {services.items.find((service) => service.id === row.serviceId)
                  ?.name ?? row.serviceId}{" "}
                · v{row.version} · <code>{row.id}</code> ·{" "}
                {row.enabled ? t("settings.enabled") : t("settings.disabled")}
                <button
                  style={styles.button}
                  disabled={opening}
                  onClick={() => void open(row.id)}
                >
                  {t(canManage ? "settings.edit" : "settings.view")}
                </button>
              </li>
            ))}
          </ul>
          {policies.next && (
            <button
              style={styles.button}
              disabled={policies.loading}
              onClick={() => void policies.more()}
            >
              {t("policy.more")}
            </button>
          )}
          {policy !== undefined && (
            <PolicyEditor
              key={policy ? `${policy.id}:${policy.version}` : "new"}
              initial={policy ?? undefined}
              client={client}
              canManage={canManage}
              services={services.items}
              schedules={scheduleOptions}
              responders={responders.items}
              t={t}
              onCancel={() => setPolicy(undefined)}
              onSaved={() => {
                setPolicy(undefined);
                policies.refresh();
              }}
            />
          )}
        </>
      ) : (
        <>
          {!loading && !availability.items.length && (
            <p>{t("availability.empty")}</p>
          )}
          <ul>
            {availability.items.map((row) => (
              <li key={row.id}>
                {responders.items.find((person) => person.id === row.id)
                  ?.displayName ?? row.id}{" "}
                · {row.timeZone} · v{row.version}
                <button style={styles.button} onClick={() => setHours(row)}>
                  {t(canManage ? "settings.edit" : "settings.view")}
                </button>
              </li>
            ))}
          </ul>
          {availability.next && (
            <button
              style={styles.button}
              disabled={availability.loading}
              onClick={() => void availability.more()}
            >
              {t("availability.more")}
            </button>
          )}
          {hours !== undefined && (
            <AvailabilityEditor
              key={hours ? `${hours.id}:${hours.version}` : "new"}
              initial={hours ?? undefined}
              client={client}
              canManage={canManage}
              responders={responders.items}
              t={t}
              onCancel={() => setHours(undefined)}
              onSaved={() => {
                setHours(undefined);
                availability.refresh();
              }}
            />
          )}
        </>
      )}
      {services.next && (
        <button
          style={styles.button}
          disabled={services.loading}
          onClick={() => void services.more()}
        >
          {t("oncall.moreServices")}
        </button>
      )}
      {schedules.next && (
        <button
          style={styles.button}
          disabled={schedules.loading}
          onClick={() => void schedules.more()}
        >
          {t("oncall.moreSchedules")}
        </button>
      )}
      {responders.next && (
        <button
          style={styles.button}
          disabled={responders.loading}
          onClick={() => void responders.more()}
        >
          {t("settings.moreResponders")}
        </button>
      )}
    </section>
  );
}
