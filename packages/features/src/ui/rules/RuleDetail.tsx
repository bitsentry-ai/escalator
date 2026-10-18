import { RuleDefinition } from "./RuleDefinition.js";
import { useEffect, useState } from "react";
import {
  reviewRuleSchema,
  type RuleCatalogView,
  type RuleReviewReceipt,
} from "../../contracts/index.js";
import { styles } from "../incidents/styles.js";
import type { RulesProps } from "./types.js";
import { useRuleAction } from "./useRuleAction.js";
import { RuleEditor } from "./RuleEditor.js";
import { RuleEvidence } from "./RuleEvidence.js";
import { RuleHistory } from "./RuleHistory.js";
export function RuleDetail({
  client,
  scope,
  t,
  id,
  access,
  onChanged,
  onAdopt,
}: RulesProps & {
  id: string;
  access: { canPropose: boolean; canApprove: boolean };
  onChanged: () => void;
  onAdopt: (id: string) => void;
}) {
  const [view, setView] = useState<RuleCatalogView | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(false),
    [reload, setReload] = useState(0),
    [editing, setEditing] = useState(false);
  const [receipt, setReceipt] = useState<RuleReviewReceipt | null>(null),
    [version, setVersion] = useState("1"),
    [mode, setMode] = useState<"shadow" | "active">("shadow"),
    [runId, setRunId] = useState(""),
    [eligibleRun, setEligibleRun] = useState("");
  const action = useRuleAction();
  const refresh = () => {
    setReceipt(null);
    setRunId("");
    setEligibleRun("");
    setEditing(false);
    setReload((n) => n + 1);
    onChanged();
  };
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(false);
    setView(null);
    setReceipt(null);
    void client
      .get({ id })
      .then((row) => {
        if (!current) return;
        if (!row) throw new Error("Rule not found");
        setView(row);
        setVersion(String(row.entry.versionRevision));
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
  if (loading) return <p role="status">{t("sources.loading")}</p>;
  if (error || !view)
    return (
      <div>
        <p role="alert">{t("rules.loadError")}</p>
        <button onClick={refresh}>{t("sources.refresh")}</button>
      </div>
    );
  return (
    <section style={styles.card} aria-label={view.entry.title}>
      <h2>{view.entry.title}</h2>
      <p>
        {t(`rules.states.${view.entry.status}`)} · {t("rules.version")}{" "}
        {view.version.revision}
      </p>
      <button type="button" disabled={action.pending} onClick={refresh}>
        {t("sources.refresh")}
      </button>
      <RuleDefinition definition={view.version.definition} t={t} />
      <button
        type="button"
        disabled={action.pending}
        onClick={() =>
          void action.run(
            () => client.export({ id }),
            (document) => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(document, null, 2)], {
                  type: "application/json",
                }),
              );
              const link = documentDownload(url);
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 0);
            },
          )
        }
      >
        {t("rules.export")}
      </button>
      {access.canPropose &&
        ["draft", "retired"].includes(view.entry.status) && (
          <button type="button" onClick={() => setEditing(!editing)}>
            {t("rules.edit")}
          </button>
        )}
      {editing && (
        <RuleEditor
          key={view.entry.revision}
          client={client}
          scope={scope}
          t={t}
          view={view}
          onSaved={refresh}
        />
      )}
      {access.canApprove && view.entry.status !== "retired" && (
        <button
          type="button"
          disabled={action.pending}
          onClick={() => {
            setReceipt(null);
            void action.run(
              () =>
                client.retire({
                  ruleId: id,
                  expectedRevision: view.entry.revision,
                }),
              refresh,
            );
          }}
        >
          {t("rules.retire")}
        </button>
      )}
      <RuleEvidence
        key={`${id}:${reload}`}
        client={client}
        scope={scope}
        t={t}
        view={view}
        canPropose={access.canPropose}
        selectedRun={runId}
        onReviewRun={setEligibleRun}
        onRun={(value) => {
          setRunId(value);
          setEligibleRun("");
          setReceipt(null);
        }}
        onChanged={onChanged}
        onAdopt={onAdopt}
      />
      {access.canApprove && (
        <fieldset disabled={action.pending}>
          <legend>{t("rules.review")}</legend>
          <p>{t("rules.reviewHelp")}</p>
          <label style={styles.label}>
            {t("rules.reviewVersion")}
            <input
              type="number"
              min={1}
              step={1}
              value={version}
              onChange={(e) => {
                setVersion(e.target.value);
                setReceipt(null);
              }}
            />
          </label>
          <label style={styles.label}>
            {t("rules.mode")}
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as typeof mode);
                setReceipt(null);
              }}
            >
              <option value="shadow">{t("rules.states.shadow")}</option>
              <option value="active">{t("rules.states.active")}</option>
            </select>
          </label>
          <button
            type="button"
            disabled={mode === "active" && !eligibleRun}
            onClick={() => {
              setReceipt(null);
              void action.run(
                () =>
                  client.review(
                    reviewRuleSchema.parse({
                      ruleId: id,
                      expectedRevision: view.entry.revision,
                      versionRevision: Number(version),
                      mode,
                      runId: eligibleRun || null,
                    }),
                  ),
                setReceipt,
              );
            }}
          >
            {t("rules.review")}
          </button>
          {receipt && (
            <div role="status">
              <p>
                {t("rules.reviewedUntil")} {receipt.expiresAt} ·{" "}
                {t(`rules.states.${receipt.mode}`)} · {t("rules.version")}{" "}
                {receipt.versionRevision}
              </p>
              <button
                type="button"
                onClick={() => {
                  const reviewed = receipt;
                  setReceipt(null);
                  void action.run(
                    () =>
                      client.activate({ ruleId: id, receiptId: reviewed.id }),
                    refresh,
                  );
                }}
              >
                {t("rules.confirmActivation")}
              </button>
            </div>
          )}
        </fieldset>
      )}
      {action.error && <p role="alert">{t("rules.actionError")}</p>}
      <RuleHistory
        key={`${id}:${reload}`}
        client={client}
        scope={scope}
        t={t}
        id={id}
      />
    </section>
  );
}
function documentDownload(url: string) {
  const link = window.document.createElement("a");
  link.href = url;
  link.download = "escalator-rule.json";
  return link;
}
