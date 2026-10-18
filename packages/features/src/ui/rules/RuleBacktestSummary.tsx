import type { RuleReplayResult } from "../../contracts/index.js";
import type { RuleText } from "./types.js";
export function RuleBacktestSummary({
  report,
  t,
}: {
  report: RuleReplayResult;
  t: RuleText;
}) {
  return (
    <>
      <p>
        {t(`rules.workStates.${report.state}`)} · {report.firstDecisionAt} —{" "}
        {report.lastDecisionAt}
      </p>
      {report.report && (
        <dl>
          <dt>{t("rules.reportStatus")}</dt>
          <dd>{t(`rules.reportStates.${report.report.status}`)}</dd>
          <dt>{t("rules.reportReason")}</dt>
          <dd>{t(`rules.reportReasons.${report.report.reason}`)}</dd>
          <dt>{t("rules.suppressed")}</dt>
          <dd>{report.report.coverage.suppressedDecisions}</dd>
          <dt>{t("rules.unknownDecisions")}</dt>
          <dd>{report.report.coverage.unknownDecisions}</dd>
          <dt>{t("rules.coverage")}</dt>
          <dd>
            {report.report.coverage.evaluatedDecisions} /{" "}
            {report.report.coverage.totalDecisions}
          </dd>
          <dt>{t("rules.episodes")}</dt>
          <dd>{report.report.episodeCount}</dd>
          <dt>{t("rules.truePositives")}</dt>
          <dd>{report.report.truePositives}</dd>
          <dt>{t("rules.falsePositives")}</dt>
          <dd>{report.report.falsePositives}</dd>
          <dt>{t("rules.unreviewed")}</dt>
          <dd>{report.report.unreviewedEpisodes}</dd>
          <dt>{t("rules.missed")}</dt>
          <dd>{report.report.missedLabels}</dd>
          <dt>{t("rules.unevaluable")}</dt>
          <dd>{report.report.unevaluableLabels}</dd>
          <dt>{t("rules.precision")}</dt>
          <dd>
            {report.report.precision.value === null
              ? t("rules.unknown")
              : new Intl.NumberFormat(undefined, {
                  style: "percent",
                  maximumFractionDigits: 1,
                }).format(report.report.precision.value)}
          </dd>
          <dt>{t("rules.precisionDenominator")}</dt>
          <dd>{report.report.precision.denominator}</dd>
          <dt>{t("rules.precisionInterval")}</dt>
          <dd>
            {report.report.precision.wilson95
              ? `${percent(report.report.precision.wilson95.low)} — ${percent(report.report.precision.wilson95.high)}`
              : t("rules.unknown")}
          </dd>
          <dt>{t("rules.labelCoverage")}</dt>
          <dd>
            {report.report.labelCoverage === null
              ? t("rules.unknown")
              : percent(report.report.labelCoverage)}
          </dd>
        </dl>
      )}
      <p>{t("rules.reportHelp")}</p>
    </>
  );
}

function percent(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}
