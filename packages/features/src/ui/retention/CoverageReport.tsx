import { useState } from "react";
import type { ReplayCoverageResult } from "../../contracts/index.js";
export function CoverageReport({
  result,
  t,
}: {
  result: ReplayCoverageResult;
  t: (key: string) => string;
}) {
  const [page, setPage] = useState(0);
  const report = result.report;
  return (
    <section aria-label={t("retention.coverage")}>
      <p>
        {t("retention.snapshot")}: {result.snapshotAt}
      </p>
      <p>
        {t("retention.unassigned")}: {result.unassignedReceipts}
      </p>
      {!report.queryComplete && <p role="alert">{t("retention.truncated")}</p>}
      {"expectedSlots" in report ? (
        <>
          <p>
            {t("retention.available")}: {report.availableSlots} /{" "}
            {report.expectedSlots}
          </p>
          {report.expectedSlots === 0 && <p>{t("retention.noExpectation")}</p>}
          <table>
            <thead>
              <tr>
                <th>{t("retention.from")}</th>
                <th>{t("retention.to")}</th>
                <th>{t("retention.reason")}</th>
              </tr>
            </thead>
            <tbody>
              {report.gaps
                .slice(page * 100, (page + 1) * 100)
                .map((gap, index) => (
                  <tr key={`${gap.startAt}-${index}`}>
                    <td>{gap.startAt}</td>
                    <td>{gap.endAt}</td>
                    <td>{t(`retention.gap.${gap.reason}`)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <button
            disabled={page === 0}
            onClick={() => setPage((value) => value - 1)}
          >
            {t("retention.previous")}
          </button>
          <button
            disabled={(page + 1) * 100 >= report.gaps.length}
            onClick={() => setPage((value) => value + 1)}
          >
            {t("retention.more")}
          </button>
        </>
      ) : (
        <>
          <p>
            {t("retention.events")}: {report.visibleCount}
          </p>
          <p>
            {t("retention.late")}: {report.lateCount}
          </p>
          <p>
            {t("retention.retrospective")}: {report.retrospectiveCount}
          </p>
          <p>{t("retention.noContinuity")}</p>
        </>
      )}
    </section>
  );
}
