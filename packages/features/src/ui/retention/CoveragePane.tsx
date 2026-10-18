import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplayCoverageResult } from "../../contracts/index.js";
import type { RetentionClient, CoverageKind } from "../retention-client.js";
import type { ProbePageInput } from "../probes-client.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import { coverageInput, localDateInput } from "./form.js";
import { CoverageReport } from "./CoverageReport.js";
export function CoveragePane({
  client,
  kind,
  t,
}: {
  client: RetentionClient;
  kind: CoverageKind;
  t: (key: string) => string;
}) {
  const fetch = useCallback(
    (input: ProbePageInput) => client.streams(kind, input),
    [client, kind],
  );
  const streams = useIncidentCollection(fetch);
  const [id, setId] = useState("");
  const [end, setEnd] = useState(() =>
    localDateInput(new Date(Math.floor(Date.now() / 60000) * 60000 - 60000)),
  );
  const [start, setStart] = useState(() =>
    localDateInput(
      new Date(Math.floor(Date.now() / 60000) * 60000 - 60000 - 7 * 86400000),
    ),
  );
  const [cutoff, setCutoff] = useState(end);
  const [result, setResult] = useState<{
      client: RetentionClient;
      data: ReplayCoverageResult;
    }>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [client],
  );
  function clear() {
    generation.current++;
    setResult(undefined);
    setError(false);
    setBusy(false);
  }
  const validSelection = streams.items.some((item) => item.id === id);
  return (
    <div>
      {streams.loading && <p role="status">{t("sources.loading")}</p>}
      {streams.error && <p role="alert">{t("retention.error")}</p>}
      <button
        disabled={streams.loading || busy}
        onClick={() => {
          clear();
          setId("");
          streams.refresh();
        }}
      >
        {t("sources.refresh")}
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !validSelection) return;
          const current = ++generation.current;
          setBusy(true);
          setResult(undefined);
          setError(false);
          void Promise.resolve()
            .then(() =>
              client.coverage(coverageInput(kind, id, start, end, cutoff)),
            )
            .then((data) => {
              if (current === generation.current) setResult({ client, data });
            })
            .catch(() => {
              if (current === generation.current) setError(true);
            })
            .finally(() => {
              if (current === generation.current) setBusy(false);
            });
        }}
      >
        <fieldset disabled={busy}>
          <legend>{t("retention.window")}</legend>
          <label>
            {t("retention.stream")}{" "}
            <select
              required
              value={id}
              onChange={(event) => {
                clear();
                setId(event.target.value);
              }}
            >
              <option value="">{t("retention.choose")}</option>
              {streams.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <p>
            {t("retention.localTime")}:{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </p>
          <label>
            {t("retention.from")}{" "}
            <input
              required
              type="datetime-local"
              value={start}
              onChange={(event) => {
                clear();
                setStart(event.target.value);
              }}
            />
          </label>
          <label>
            {t("retention.to")}{" "}
            <input
              required
              type="datetime-local"
              value={end}
              onChange={(event) => {
                clear();
                setEnd(event.target.value);
              }}
            />
          </label>
          <label>
            {t("retention.asOf")}{" "}
            <input
              required
              type="datetime-local"
              value={cutoff}
              onChange={(event) => {
                clear();
                setCutoff(event.target.value);
              }}
            />
          </label>
          <button type="submit" disabled={!validSelection || streams.loading}>
            {t("retention.load")}
          </button>
        </fieldset>
      </form>
      {streams.next && (
        <button
          disabled={busy || streams.loading}
          onClick={() => void streams.more()}
        >
          {t("retention.more")}
        </button>
      )}
      {busy && <p role="status">{t("sources.loading")}</p>}
      {error && <p role="alert">{t("retention.error")}</p>}
      {result?.client === client && (
        <CoverageReport result={result.data} t={t} />
      )}
    </div>
  );
}
