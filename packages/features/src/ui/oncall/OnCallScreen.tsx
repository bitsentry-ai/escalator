import { useState } from "react";
import type { Schedule } from "../../contracts/index.js";
import type { OnCallClient } from "../oncall-client.js";
import { useIncidentCollection as useCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
import { ScheduleEditor } from "./ScheduleEditor.js";
export function OnCallScreen({
  client,
  canManage,
  t,
}: {
  client: OnCallClient;
  canManage: boolean;
  t: (key: string) => string;
}) {
  const schedules = useCollection(client.schedules);
  const services = useCollection(client.services);
  const responders = useCollection(client.responders);
  const [selected, setSelected] = useState<Schedule | null>();
  const loading = schedules.loading || services.loading || responders.loading;
  const error = schedules.error || services.error || responders.error;
  return (
    <section aria-label={t("oncall.heading")}>
      <h1>{t("oncall.heading")}</h1>
      {loading && <p role="status">{t("oncall.loading")}</p>}
      {error && <p role="alert">{t("oncall.error")}</p>}
      <button
        style={styles.button}
        disabled={loading}
        onClick={() => {
          schedules.refresh();
          services.refresh();
          responders.refresh();
        }}
      >
        {t("oncall.refreshLists")}
      </button>{" "}
      {canManage && (
        <button
          style={styles.button}
          disabled={
            selected === null ||
            !services.items.some((service) => service.enabled)
          }
          onClick={() => setSelected(null)}
        >
          {t("oncall.newSchedule")}
        </button>
      )}
      {!services.loading &&
        !services.error &&
        !services.next &&
        !services.items.some((service) => service.enabled) && (
          <p>{t("oncall.requiresService")}</p>
        )}
      {!schedules.loading && !schedules.items.length && !schedules.error && (
        <p>{t("oncall.empty")}</p>
      )}
      <ul>
        {schedules.items.map((schedule) => (
          <li key={schedule.id}>
            <button
              style={styles.button}
              aria-pressed={selected?.id === schedule.id}
              onClick={() => setSelected(schedule)}
            >
              {schedule.name}
            </button>{" "}
            <span>
              {services.items.find(
                (service) => service.id === schedule.serviceId,
              )?.name ?? schedule.serviceId}{" "}
              · {schedule.enabled ? t("oncall.enabled") : t("oncall.disabled")}
            </span>
          </li>
        ))}
      </ul>
      {schedules.next && (
        <button
          style={styles.button}
          disabled={schedules.loading}
          onClick={() => void schedules.more()}
        >
          {t("oncall.moreSchedules")}
        </button>
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
      {responders.next && (
        <button
          style={styles.button}
          disabled={responders.loading}
          onClick={() => void responders.more()}
        >
          {t("oncall.moreResponders")}
        </button>
      )}
      {selected !== undefined && (
        <ScheduleEditor
          key={selected ? `${selected.id}:${selected.version}` : "new"}
          initial={selected ?? undefined}
          services={services.items}
          responders={responders.items}
          client={client}
          canManage={canManage}
          t={t}
          onSaved={(value) => {
            setSelected(value);
            schedules.refresh();
          }}
        />
      )}
    </section>
  );
}
