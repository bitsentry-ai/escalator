import { styles } from "../incidents/styles.js";
import { useState } from "react";
import type {
  DeploymentWatchView,
  EvaluatedWatchStream,
  WatchStreamEvaluation,
} from "../../contracts/index.js";
type Text = (key: string) => string;
export function WatchSummary({
  value,
  t,
}: {
  value: DeploymentWatchView;
  t: Text;
}) {
  const { deployment: d, watch: w } = value;
  const [selected, setSelected] = useState("first");
  const stream =
    selected === "first"
      ? w?.firstFailure
      : w?.streams.find((s) => `${s.kind}:${s.id}` === selected);
  return (
    <>
      <dl>
        <dt>{t("deployments.release")}</dt>
        <dd>
          {d.source}: {d.externalId}
        </dd>
        <dt>{t("deployments.lifecycle")}</dt>
        <dd>{t(`deployments.status.${d.status}`)}</dd>
        <dt>{t("deployments.commit")}</dt>
        <dd>{d.commit ?? d.artifact}</dd>
        <dt>{t("deployments.actor")}</dt>
        <dd>{d.actor}</dd>
        <dt>{t("deployments.mappedDeployer")}</dt>
        <dd>{d.mappedDeployerId ?? t("deployments.gate.unmapped_deployer")}</dd>
        <dt>{t("deployments.timeout")}</dt>
        <dd>{d.timeoutAt}</dd>
        <dt>{t("deployments.started")}</dt>
        <dd>{d.startedAt}</dd>
        {d.finish && (
          <>
            <dt>{t("deployments.finished")}</dt>
            <dd>
              {t(`deployments.status.${d.finish.outcome}`)} ·{" "}
              {d.finish.occurredAt}
            </dd>
          </>
        )}
      </dl>
      <h3>{t("deployments.watch")}</h3>
      <p>{t("deployments.watchGuidance")}</p>
      {!value.baselineAvailable && <p>{t("deployments.noBaseline")}</p>}
      {!w ? (
        <p>{t("deployments.noWatch")}</p>
      ) : (
        <>
          <p>
            <strong>{t(`deployments.verdict.${w.verdict}`)}</strong>
          </p>
          <dl>
            <dt>{t("deployments.window")}</dt>
            <dd>
              {w.startedAt} — {w.endsAt}
            </dd>
            <dt>{t("deployments.evaluated")}</dt>
            <dd>{w.evaluatedAt ?? t("deployments.notEvaluated")}</dd>
            <dt>{t("deployments.finalized")}</dt>
            <dd>{w.finalizedAt ?? t("deployments.notFinal")}</dd>
          </dl>
          {!w.inventoryComplete && <p>{t("deployments.incomplete")}</p>}
          {(w.overlappingDeploymentIds.length > 0 ||
            !w.overlapInventoryComplete) && (
            <p>{t("deployments.overlapWarning")}</p>
          )}
          {!w.overlapInventoryComplete && (
            <p>{t("deployments.incompleteOverlap")}</p>
          )}
          {w.overlappingDeploymentIds.length > 0 && (
            <details>
              <summary>
                {t("deployments.overlaps")} ({w.overlappingDeploymentIds.length}
                )
              </summary>
              <ul>
                {w.overlappingDeploymentIds.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </details>
          )}
          <label style={styles.label}>
            {t("deployments.stream")}{" "}
            <select
              style={styles.input}
              value={stream ? selected : ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">{t("deployments.choose")}</option>
              {w.firstFailure && (
                <option value="first">{t("deployments.firstFailure")}</option>
              )}
              {w.streams.map((s) => (
                <option key={`${s.kind}:${s.id}`} value={`${s.kind}:${s.id}`}>
                  {t(s.kind === "probe" ? "probes.heading" : "metrics.heading")}
                  : {s.id} · {t(`deployments.verdict.${s.evaluation.verdict}`)}
                </option>
              ))}
            </select>
          </label>
          {stream && (
            <StreamEvidence
              key={`${selected}:${w.revision}`}
              stream={stream}
              t={t}
            />
          )}
        </>
      )}
    </>
  );
}
export function StreamEvidence({
  stream,
  t,
}: {
  stream: EvaluatedWatchStream;
  t: Text;
}) {
  const e = stream.evaluation;
  return (
    <section style={styles.card} aria-label={t("deployments.evidence")}>
      <h4>
        {t("deployments.evidence")}:{" "}
        {t(stream.kind === "probe" ? "probes.heading" : "metrics.heading")}/
        {stream.id}
      </h4>
      <p>
        {t(`deployments.verdict.${e.verdict}`)} ·{" "}
        {t(`deployments.reason.${e.reason}`)}
      </p>
      <p>
        {t("deployments.source")}: {stream.sourceId} ·{" "}
        {t("deployments.evaluated")}: {e.evaluatedAt}
      </p>
      {e.criteria.kind === "metric" ? (
        <dl>
          <dt>{t("deployments.minimumRequests")}</dt>
          <dd>{e.criteria.minimumRequests}</dd>
          <dt>{t("deployments.baselineRate")}</dt>
          <dd>{rate(e.baselineErrorRate, t)}</dd>
          <dt>{t("deployments.watchRate")}</dt>
          <dd>{rate(e.watchErrorRate, t)}</dd>
          <dt>{t("deployments.threshold")}</dt>
          <dd>{rate(e.effectiveErrorRateThreshold, t)}</dd>
        </dl>
      ) : (
        <p>
          {t("deployments.failureRun")}:{" "}
          {e.longestFailureRun ?? t("deployments.unknown")} /{" "}
          {e.criteria.failureThreshold}
        </p>
      )}
      <EvidenceWindow
        title={t("deployments.baseline")}
        value={e.baseline}
        t={t}
      />
      <EvidenceWindow title={t("deployments.watch")} value={e.watch} t={t} />
    </section>
  );
}
function rate(value: number | null, t: Text) {
  return value === null
    ? t("deployments.unknown")
    : `${Number((value * 100).toPrecision(4))}%`;
}
export function EvidenceWindow({
  title,
  value,
  t,
}: {
  title: string;
  value: WatchStreamEvaluation["watch"];
  t: Text;
}) {
  const [evidencePage, setEvidencePage] = useState(0),
    [gapPage, setGapPage] = useState(0);
  const evidence = value.evidence.slice(
      evidencePage * 25,
      (evidencePage + 1) * 25,
    ),
    gaps = value.coverage.gaps.slice(gapPage * 25, (gapPage + 1) * 25);
  return (
    <section style={styles.card} aria-label={title}>
      <h5>{title}</h5>
      <p>
        {t("deployments.coverage")}: {value.coverage.availableSlots}/
        {value.coverage.expectedSlots}
      </p>
      {!value.coverage.queryComplete && <p>{t("deployments.incomplete")}</p>}
      <p>
        {t("deployments.counts")}: {value.requests ?? t("deployments.unknown")}{" "}
        / {value.errors ?? t("deployments.unknown")} /{" "}
        {value.failedProbes ?? t("deployments.unknown")}
      </p>
      <h6>
        {t("deployments.references")} ({value.evidence.length})
      </h6>
      <ul>
        {evidence.map((x, i) => (
          <li key={`${x.id}:${x.version}:${i}`}>
            {x.id} · v{x.version} · {x.slotAt} · {x.stepSeconds}s
          </li>
        ))}
      </ul>
      <Pager
        page={evidencePage}
        count={value.evidence.length}
        setPage={setEvidencePage}
        t={t}
      />
      <h6>
        {t("deployments.gaps")} ({value.coverage.gaps.length})
      </h6>
      <ul>
        {gaps.map((x, i) => (
          <li key={i}>
            {x.startAt} — {x.endAt}: {t(`retention.gap.${x.reason}`)}
          </li>
        ))}
      </ul>
      <Pager
        page={gapPage}
        count={value.coverage.gaps.length}
        setPage={setGapPage}
        t={t}
      />
    </section>
  );
}
function Pager({
  page,
  count,
  setPage,
  t,
}: {
  page: number;
  count: number;
  setPage: (page: number) => void;
  t: Text;
}) {
  if (count <= 25) return null;
  return (
    <div>
      <button
        style={styles.button}
        disabled={page === 0}
        onClick={() => setPage(page - 1)}
      >
        {t("deployments.previous")}
      </button>{" "}
      {page + 1}/{Math.ceil(count / 25)}{" "}
      <button
        style={styles.button}
        disabled={(page + 1) * 25 >= count}
        onClick={() => setPage(page + 1)}
      >
        {t("deployments.next")}
      </button>
    </div>
  );
}
