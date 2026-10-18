import type { MetricObservationRecord } from "../../contracts/index.js";
export function MetricObservation({
  observation,
  currentVersion,
  t,
}: {
  observation: MetricObservationRecord;
  currentVersion: number;
  t: (key: string) => string;
}) {
  return (
    <article>
      <p>
        <time dateTime={observation.observedAt}>{observation.observedAt}</time>{" "}
        · {t("probes.version")} {observation.monitorVersion}
      </p>
      <p>
        {t("metrics.received")}{" "}
        <time dateTime={observation.receivedAt}>{observation.receivedAt}</time>
      </p>
      <p>
        {t("metrics.states." + observation.evaluation.state)} ·{" "}
        {t("metrics.reasons." + observation.evaluation.reason)}
      </p>
      <p>{t("metrics.providerReasons." + observation.reason)}</p>
      <p>
        {t("metrics.sampleCount")} {observation.evaluation.sampleCount}
      </p>
      {observation.monitorVersion !== currentVersion && (
        <p>{t("metrics.differentVersion")}</p>
      )}
    </article>
  );
}
