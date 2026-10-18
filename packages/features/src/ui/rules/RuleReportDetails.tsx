import { useEffect, useState } from "react";
import type {
  RuleReportDetail,
  RuleReportDetailInput,
} from "../../contracts/index.js";
import type { RulesProps } from "./types.js";
import { useRuleAction } from "./useRuleAction.js";
type Props = Pick<RulesProps, "client" | "t"> & { runId: string };
const sections = {
  episodes: "rules.episodes",
  gaps: "rules.historyGaps",
  comparison: "rules.recordedComparison",
} as const;
export function RuleReportDetails(props: Props) {
  const [section, setSection] =
    useState<RuleReportDetailInput["section"]>("episodes");
  return (
    <section>
      <nav>
        {Object.entries(sections).map(([key, label]) => (
          <button
            type="button"
            key={key}
            aria-pressed={section === key}
            onClick={() => setSection(key as typeof section)}
          >
            {props.t(label)}
          </button>
        ))}
      </nav>
      <DetailPage
        key={`${props.runId}:${section}`}
        {...props}
        section={section}
      />
    </section>
  );
}
function DetailPage({
  client,
  t,
  runId,
  section,
}: Props & { section: RuleReportDetailInput["section"] }) {
  const [pages, setPages] = useState<RuleReportDetail[]>([]),
    [next, setNext] = useState<number | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(false),
    [reload, setReload] = useState(0);
  const action = useRuleAction();
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(false);
    setPages([]);
    setNext(null);
    void client
      .reportDetail({ runId, section, offset: 0, limit: 10 })
      .then((page) => {
        if (!current) return;
        if (!page || page.section !== section || page.runId !== runId)
          throw new Error("Report unavailable");
        setPages([page]);
        setNext(page.next);
      })
      .catch(() => {
        if (current) setError(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, runId, section, reload]);
  const first = pages[0];
  return (
    <>
      <button
        type="button"
        disabled={loading || action.pending}
        onClick={() => setReload((n) => n + 1)}
      >
        {t("sources.refresh")}
      </button>
      {loading && <p role="status">{t("sources.loading")}</p>}
      {(error || action.error) && <p role="alert">{t("rules.loadError")}</p>}
      {first?.section === "comparison" && (
        <>
          <p>{t("rules.comparisonHelp")}</p>
          <p>
            {t(
              `rules.comparisonStates.${first.comparison?.status ?? "no_recorded_comparison"}`,
            )}
          </p>
          {first.comparison &&
            (!first.comparison.captureComplete ||
              first.comparison.legacyUnknown) && (
              <p>{t("rules.baselineIncomplete")}</p>
            )}
        </>
      )}
      {!loading &&
        !error &&
        pages.length > 0 &&
        pages.every((page) => page.items.length === 0) && (
          <p>{t("rules.noRows")}</p>
        )}
      {pages.map((page, index) => (
        <ul key={index}>
          {page.section === "episodes"
            ? page.items.map((row, n) => (
                <li key={n}>
                  {row.startedAt} — {row.endedAt ?? t("rules.openEpisode")} ·{" "}
                  {t(`rules.episodeOutcomes.${row.outcome}`)}
                </li>
              ))
            : page.section === "gaps"
              ? page.items.map((row, n) => (
                  <li key={n}>
                    {row.range.firstDecisionAt} — {row.range.lastDecisionAt} ·{" "}
                    {row.range.decisions} · {row.reason}
                  </li>
                ))
              : page.items.map((row, n) => (
                  <li key={n}>
                    {row.observation.version.id} · {t("rules.version")}{" "}
                    {row.observation.version.revision} ·{" "}
                    {t(`rules.states.${row.observation.mode}`)}
                    <br />
                    {row.observation.firstObservedDecisionAt} —{" "}
                    {row.observation.lastObservedDecisionAt}
                    <br />
                    {t("rules.observedOpenings")}: {row.observation.opened} ·{" "}
                    {t("rules.coverage")}: {row.observation.evaluated}/
                    {row.expectedDecisions} · {t("rules.missingDecisions")}:{" "}
                    {row.missingDecisions}
                  </li>
                ))}
        </ul>
      ))}
      {next !== null && (
        <button
          type="button"
          disabled={loading || action.pending}
          onClick={() => {
            const offset = next;
            if (offset === null) return;
            void action.run(
              async () => {
                const page = await client.reportDetail({
                  runId,
                  section,
                  offset,
                  limit: 10,
                });
                if (!page || page.section !== section || page.runId !== runId)
                  throw new Error("Report unavailable");
                return page;
              },
              (page) => {
                setPages((old) => [...old, page]);
                setNext(page.next);
              },
            );
          }}
        >
          {t("deployments.more")}
        </button>
      )}
    </>
  );
}
