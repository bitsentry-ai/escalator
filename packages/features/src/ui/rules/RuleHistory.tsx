import { useEffect, useState } from "react";
import type { RuleActivationHistory } from "../../contracts/index.js";
import type { RulesProps } from "./types.js";
import { useRuleAction } from "./useRuleAction.js";
export function RuleHistory({ client, t, id }: RulesProps & { id: string }) {
  const [items, setItems] = useState<RuleActivationHistory[]>([]),
    [next, setNext] = useState<number | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(false),
    [reload, setReload] = useState(0);
  const action = useRuleAction();
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(false);
    setItems([]);
    setNext(null);
    void client
      .history({ ruleId: id, limit: 20 })
      .then((page) => {
        if (current) {
          setItems(page.items);
          setNext(page.next);
        }
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
  }, [client, id, reload]);
  return (
    <section>
      <h3>{t("rules.history")}</h3>
      {loading && <p role="status">{t("sources.loading")}</p>}
      {(error || action.error) && <p role="alert">{t("rules.loadError")}</p>}
      <button
        type="button"
        disabled={loading || action.pending}
        onClick={() => setReload((n) => n + 1)}
      >
        {t("sources.refresh")}
      </button>
      <ul>
        {items.map((row) => (
          <li key={row.id}>
            {row.recordedAt} — {t(`rules.historyActions.${row.action}`)} ·{" "}
            {t("rules.version")} {row.versionRevision}
          </li>
        ))}
      </ul>
      {next !== null && (
        <button
          type="button"
          disabled={loading || action.pending}
          onClick={() =>
            void action.run(
              () =>
                client.history({ ruleId: id, limit: 20, afterRevision: next }),
              (page) => {
                setItems((old) => [
                  ...old,
                  ...page.items.filter(
                    (row) => !old.some((prior) => prior.id === row.id),
                  ),
                ]);
                setNext(page.next);
              },
            )
          }
        >
          {t("deployments.more")}
        </button>
      )}
    </section>
  );
}
