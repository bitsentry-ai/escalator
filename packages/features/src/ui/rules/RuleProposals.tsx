import { RuleDefinition } from "./RuleDefinition.js";
import { useCallback, useEffect, useState } from "react";
import {
  incidentLabelsQuerySchema,
  ruleResultsListSchema,
  modelProfileSchema,
  type IncidentPageInput,
  type RuleReplayResult,
  type RuleProposalView,
} from "../../contracts/index.js";
import { Choice } from "../labels/Choice.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
import type { RulesProps } from "./types.js";
import { useRuleAction } from "./useRuleAction.js";
export function RuleProposals({
  client,
  scope,
  t,
  capture,
  canPropose,
  onChanged,
  onRun,
  onAdopt,
}: RulesProps & {
  capture: RuleReplayResult | null;
  canPropose: boolean;
  onChanged: () => void;
  onRun: (id: string) => void;
  onAdopt: (id: string) => void;
}) {
  const fetch = useCallback(
    (page: IncidentPageInput) =>
      client.proposals(ruleResultsListSchema.parse({ ...scope, ...page })),
    [client, scope.serviceId, scope.environmentId],
  );
  const list = useIncidentCollection(fetch);
  return (
    <section>
      <h3>{t("rules.proposals")}</h3>
      <p>{t("rules.proposalHelp")}</p>
      {capture?.proposalSource && canPropose && (
        <ProposalRequest
          key={capture.snapshotId}
          client={client}
          scope={scope}
          t={t}
          capture={capture}
          onCreated={() => list.refresh()}
        />
      )}
      {!capture?.proposalSource && canPropose && (
        <p>{t("rules.chooseOriginalCapture")}</p>
      )}
      <button type="button" onClick={list.refresh}>
        {t("sources.refresh")}
      </button>
      {list.loading && <p role="status">{t("sources.loading")}</p>}
      {list.error && <p role="alert">{t("rules.loadError")}</p>}
      {list.items.map((proposal) => (
        <ProposalCard
          key={`${proposal.id}:${proposal.status}`}
          client={client}
          scope={scope}
          t={t}
          proposal={proposal}
          canPropose={canPropose}
          onRun={onRun}
          onAdopt={(id) => {
            list.refresh();
            onChanged();
            onAdopt(id);
          }}
        />
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
    </section>
  );
}
function ProposalRequest({
  client,
  scope,
  t,
  capture,
  onCreated,
}: RulesProps & { capture: RuleReplayResult; onCreated: () => void }) {
  const [label, setLabel] = useState(""),
    [profile, setProfile] = useState<{ id: string; name: string } | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(false),
    [reload, setReload] = useState(0);
  const action = useRuleAction(),
    selector = capture.version.definition.selector;
  useEffect(() => {
    let current = true;
    setProfile(null);
    setLoading(true);
    setError(false);
    void client
      .modelSettings(
        modelProfileSchema.shape.scope.omit({ workspaceId: true }).parse(scope),
      )
      .then((value) => {
        if (current && value?.enabled)
          setProfile({
            id: value.profile.id,
            name: value.profile.destination.model,
          });
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
  }, [client, scope.serviceId, scope.environmentId, reload]);
  const labels = useCallback(
    async (page: IncidentPageInput) => {
      const result = await client.labels(
        incidentLabelsQuerySchema.parse({
          ...scope,
          ...page,
          status: "reviewed",
          stream: { kind: selector.kind, id: selector.streamId },
        }),
      );
      return {
        items: result.items.map((row) => ({
          id: row.id,
          name: row.summary.slice(0, 100),
        })),
        next: result.next,
      };
    },
    [
      client,
      scope.serviceId,
      scope.environmentId,
      selector.kind,
      selector.streamId,
    ],
  );
  return (
    <fieldset disabled={action.pending}>
      <legend>{t("rules.requestProposal")}</legend>
      {loading ? (
        <p role="status">{t("sources.loading")}</p>
      ) : profile ? (
        <p>
          {t("rules.model")}: {profile.name}
        </p>
      ) : (
        <p>{t("rules.configureModel")}</p>
      )}
      {error && (
        <>
          <p role="alert">{t("rules.loadError")}</p>
          <button type="button" onClick={() => setReload((n) => n + 1)}>
            {t("sources.refresh")}
          </button>
        </>
      )}
      <Choice
        fetch={labels}
        label={t("rules.originLabel")}
        value={label}
        onChange={setLabel}
        t={t}
      />
      <button
        type="button"
        disabled={!profile || !label || loading}
        onClick={() => {
          if (!profile) return;
          void action.run(
            () =>
              client.propose({
                sourceSnapshotId: capture.snapshotId,
                originLabelId: label,
                profileId: profile.id,
              }),
            () => {
              setLabel("");
              onCreated();
            },
          );
        }}
      >
        {t("rules.requestProposal")}
      </button>
      {action.error && <p role="alert">{t("rules.actionError")}</p>}
    </fieldset>
  );
}
export function ProposalCard({
  client,
  t,
  proposal,
  canPropose,
  onRun,
  onAdopt,
}: RulesProps & {
  proposal: RuleProposalView;
  canPropose: boolean;
  onRun: (id: string) => void;
  onAdopt?: (id: string) => void;
}) {
  const [title, setTitle] = useState(t("rules.proposalDraftTitle"));
  const action = useRuleAction();
  return (
    <article style={styles.card}>
      <p>
        {proposal.createdAt} — {t(`rules.proposalStates.${proposal.status}`)}
      </p>
      {proposal.rationale && <p>{proposal.rationale}</p>}
      {proposal.candidate && (
        <RuleDefinition definition={proposal.candidate.definition} t={t} />
      )}
      {proposal.fullRunId && (
        <button type="button" onClick={() => onRun(proposal.fullRunId!)}>
          {t("rules.fullReport")}
        </button>
      )}
      {proposal.heldOutRunId && (
        <button type="button" onClick={() => onRun(proposal.heldOutRunId!)}>
          {t("rules.heldOutReport")}
        </button>
      )}
      {proposal.heldOut === "insufficient_span" && (
        <p>{t("rules.insufficientHeldOut")}</p>
      )}
      {canPropose && onAdopt && proposal.status === "ready" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(
              () => client.adopt({ proposalId: proposal.id, title }),
              (row) => onAdopt(row.id),
            );
          }}
        >
          <fieldset disabled={action.pending}>
            <label style={styles.label}>
              {t("rules.title")}
              <input
                required
                maxLength={240}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <button type="submit">{t("rules.adopt")}</button>
          </fieldset>
        </form>
      )}
      {action.error && <p role="alert">{t("rules.actionError")}</p>}
    </article>
  );
}
