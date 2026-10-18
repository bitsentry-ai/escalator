import { useCallback, useEffect, useRef, useState } from "react";
import {
  incidentLabelsQuerySchema,
  investigationSourceOptionsInputSchema,
  type IncidentPageInput,
  type IncidentLabel,
  type OperationalIncident,
} from "../../contracts/index.js";
import type { LabelsClient } from "./client.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
import { Choice } from "./Choice.js";
import { LabelForm } from "./LabelForm.js";
type Text = (key: string) => string;
type Scope = { serviceId: string; environmentId: string };
export function LabelsScreen({
  client,
  canLabel,
  t,
}: {
  client: LabelsClient;
  canLabel: boolean;
  t: Text;
}) {
  const [service, setService] = useState(""),
    [environment, setEnvironment] = useState("");
  const services = useCallback(
    (page: IncidentPageInput) => client.services(page),
    [client],
  );
  const environments = useCallback(
    (page: IncidentPageInput) => client.environments(page),
    [client],
  );
  return (
    <section style={styles.card} aria-label={t("labels.heading")}>
      <h1>{t("labels.heading")}</h1>
      <p>{t("labels.guidance")}</p>
      <Choice
        fetch={services}
        label={t("deploymentSetup.service")}
        value={service}
        onChange={setService}
        t={t}
      />
      <Choice
        fetch={environments}
        label={t("deploymentSetup.environment")}
        value={environment}
        onChange={setEnvironment}
        t={t}
      />
      {service && environment && (
        <IncidentLabels
          key={`${service}:${environment}`}
          client={client}
          scope={{ serviceId: service, environmentId: environment }}
          canLabel={canLabel}
          t={t}
        />
      )}
    </section>
  );
}
/** Also mounted inside incident detail; the linked incident is supplied by its scoped reader. */
export function IncidentLabels({
  client,
  scope,
  incident,
  canLabel,
  t,
}: {
  client: LabelsClient;
  scope: Scope;
  incident?: OperationalIncident;
  canLabel: boolean;
  t: Text;
}) {
  const [kind, setKind] = useState<"metric" | "probe" | "signal">("probe"),
    [id, setId] = useState("");
  const sources = useCallback(
    async (page: IncidentPageInput) => {
      const result = await client.sources(
        investigationSourceOptionsInputSchema.parse({
          ...scope,
          ...page,
          kind: kind === "signal" ? "alert" : kind,
        }),
      );
      return {
        items: result.items.map((item) => ({
          id: item.sourceId,
          name: item.name,
          enabled: item.enabled,
        })),
        next: result.next,
      };
    },
    [client, scope.serviceId, scope.environmentId, kind],
  );
  return (
    <section style={styles.card} aria-label={t("labels.heading")}>
      <h2>{t("labels.heading")}</h2>
      <label style={styles.label}>
        {t("labels.kind")}
        <select
          style={styles.input}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as typeof kind);
            setId("");
          }}
        >
          <option value="probe">{t("labels.probe")}</option>
          <option value="metric">{t("labels.metric")}</option>
          <option value="signal">{t("labels.signal")}</option>
        </select>
      </label>
      <Choice
        key={kind}
        fetch={sources}
        label={t("labels.source")}
        value={id}
        onChange={setId}
        t={t}
      />
      {id && (
        <LabelList
          key={`${scope.serviceId}:${scope.environmentId}:${kind}:${id}:${incident?.id ?? "missed"}`}
          client={client}
          scope={{ ...scope, stream: { kind, id } }}
          incident={incident}
          canLabel={canLabel}
          t={t}
        />
      )}
    </section>
  );
}
function LabelList({
  client,
  scope,
  incident,
  canLabel,
  t,
}: {
  client: LabelsClient;
  scope: Scope & {
    stream: { kind: "metric" | "probe" | "signal"; id: string };
  };
  incident?: OperationalIncident;
  canLabel: boolean;
  t: Text;
}) {
  const fetch = useCallback(
    (page: IncidentPageInput) =>
      client.list(
        incidentLabelsQuerySchema.parse({
          ...scope,
          ...page,
          ...(incident ? { incidentId: incident.id } : {}),
        }),
      ),
    [
      client,
      scope.serviceId,
      scope.environmentId,
      scope.stream.kind,
      scope.stream.id,
      incident?.id,
    ],
  );
  const list = useIncidentCollection(fetch);
  const [saved, setSaved] = useState<IncidentLabel>(),
    [editing, setEditing] = useState<IncidentLabel>();
  const [version, setVersion] = useState(0),
    [pending, setPending] = useState(false),
    [error, setError] = useState(false);
  const busy = useRef(false),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  function changed(value: IncidentLabel) {
    setSaved(value);
    setEditing(undefined);
    setVersion((v) => v + 1);
    list.refresh();
  }
  async function review(value: IncidentLabel) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const result = await client.review({
        id: value.id,
        expectedRevision: value.revision,
      });
      if (active.current) changed(result);
    } catch {
      if (active.current) setError(true);
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  }
  const rows = saved
    ? [saved, ...list.items.filter((item) => item.id !== saved.id)]
    : list.items;
  return (
    <>
      {canLabel && (
        <LabelForm
          key={editing ? `${editing.id}:${editing.revision}` : version}
          client={client}
          scope={scope}
          incident={incident}
          value={editing}
          onSaved={changed}
          t={t}
        />
      )}
      {editing && (
        <button type="button" onClick={() => setEditing(undefined)}>
          {t("labels.cancelEdit")}
        </button>
      )}
      <p>{t("labels.reviewHelp")}</p>
      <button
        type="button"
        disabled={list.loading || pending}
        onClick={() => {
          setSaved(undefined);
          list.refresh();
        }}
      >
        {t("sources.refresh")}
      </button>
      {list.loading && <p role="status">{t("sources.loading")}</p>}
      {(list.error || error) && <p role="alert">{t("labels.loadError")}</p>}
      {!list.loading && !list.error && rows.length === 0 && (
        <p>{t("labels.empty")}</p>
      )}
      {rows.map((label) => (
        <article key={label.id} style={styles.card}>
          <strong>
            {label.status === "reviewed"
              ? t("labels.reviewed")
              : t("labels.draft")}
          </strong>
          {" · "}
          {label.outcome === "actionable"
            ? t("labels.actionable")
            : t("labels.noise")}
          <p>
            {label.origin === "missed_incident"
              ? t("labels.missed")
              : t("labels.incidentReview")}
          </p>
          <p>
            <time dateTime={label.startedAt}>{label.startedAt}</time>
            {" — "}
            <time dateTime={label.endedAt}>{label.endedAt}</time>
          </p>
          <p style={{ whiteSpace: "pre-wrap" }}>{label.summary}</p>
          {label.reviewedAt && (
            <p>
              {t("labels.reviewedAt")}{" "}
              <time dateTime={label.reviewedAt}>{label.reviewedAt}</time>
            </p>
          )}
          {canLabel && label.status === "draft" && (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={() => setEditing(label)}
              >
                {t("labels.edit")}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void review(label)}
              >
                {t("labels.reviewAndLock")}
              </button>
            </>
          )}
        </article>
      ))}
      {list.next && (
        <button
          type="button"
          disabled={list.loading}
          onClick={() => void list.more()}
        >
          {t("deployments.more")}
        </button>
      )}
    </>
  );
}
