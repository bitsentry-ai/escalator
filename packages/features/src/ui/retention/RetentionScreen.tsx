import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RetentionClient,
  RetentionPolicyView,
  CoverageKind,
} from "../retention-client.js";
import { CoveragePane } from "./CoveragePane.js";
import { policyInput } from "./form.js";
type Text = (key: string) => string;
export function RetentionScreen({
  client,
  canManage,
  t,
}: {
  client: RetentionClient;
  canManage: boolean;
  t: Text;
}) {
  const [loaded, setLoaded] = useState<{
    client: RetentionClient;
    data: RetentionPolicyView;
  }>();
  const [error, setError] = useState(false),
    [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<CoverageKind>("probe");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const data = await client.get();
      if (current === generation.current) setLoaded({ client, data });
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const data = loaded?.client === client ? loaded.data : undefined;
  return (
    <section aria-label={t("retention.heading")}>
      <h1>{t("retention.heading")}</h1>
      <p>{t("retention.guidance")}</p>
      {loading && <p role="status">{t("sources.loading")}</p>}
      {error && <p role="alert">{t("retention.error")}</p>}
      <button disabled={loading} onClick={() => void refresh()}>
        {t("sources.refresh")}
      </button>
      {data && !loading && !error && (
        <PolicyEditor
          key={data.configured?.version ?? 0}
          client={client}
          data={data}
          canManage={canManage}
          onSaved={() => void refresh()}
          t={t}
        />
      )}
      <h2>{t("retention.coverage")}</h2>
      <p>{t("retention.coverageGuidance")}</p>
      <label>
        {t("retention.kind")}{" "}
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as CoverageKind)}
        >
          <option value="probe">{t("probes.heading")}</option>
          <option value="metric">{t("metrics.heading")}</option>
          <option value="signal">{t("sources.heading")}</option>
        </select>
      </label>
      <CoveragePane key={kind} client={client} kind={kind} t={t} />
    </section>
  );
}
function PolicyEditor({
  client,
  data,
  canManage,
  onSaved,
  t,
}: {
  client: RetentionClient;
  data: RetentionPolicyView;
  canManage: boolean;
  onSaved: () => void;
  t: Text;
}) {
  const [days, setDays] = useState(String(data.effective.days)),
    [mib, setMib] = useState(String(data.effective.maxBytes / 1024 ** 2));
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (saving || !canManage) return;
        setSaving(true);
        setError(false);
        void Promise.resolve()
          .then(() => client.update(policyInput(days, mib, data.configured)))
          .then(() => {
            if (alive.current) onSaved();
          })
          .catch(() => {
            if (alive.current) setError(true);
          })
          .finally(() => {
            if (alive.current) setSaving(false);
          });
      }}
    >
      <h2>{t("retention.policy")}</h2>
      <p>
        {t("retention.limits")}: {data.limits.days} {t("retention.days")},{" "}
        {data.limits.maxBytes / 1024 ** 2} MiB
      </p>
      <fieldset disabled={!canManage || saving}>
        <legend>{t("retention.effective")}</legend>
        <label>
          {t("retention.days")}{" "}
          <input
            required
            type="number"
            min="1"
            max={data.limits.days}
            step="1"
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        </label>
        <label>
          {t("retention.budget")}{" "}
          <input
            required
            type="number"
            min="1"
            max={data.limits.maxBytes / 1024 ** 2}
            step="any"
            value={mib}
            onChange={(event) => setMib(event.target.value)}
          />
        </label>
        {canManage && <button type="submit">{t("retention.save")}</button>}
      </fieldset>
      {saving && <p role="status">{t("sources.loading")}</p>}
      {error && <p role="alert">{t("retention.saveError")}</p>}
    </form>
  );
}
