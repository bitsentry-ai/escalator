import { styles } from "../incidents/styles.js";
import type { DeploymentCoverageDecision } from "../../contracts/index.js";
export function CoverageProof({
  proof,
  linked,
  error,
  t,
}: {
  proof?: DeploymentCoverageDecision;
  linked: boolean;
  error: boolean;
  t: (key: string) => string;
}) {
  return (
    <section style={styles.card} aria-label={t("deployments.preflight")}>
      <h3>{t("deployments.preflight")}</h3>
      {!linked && <p>{t("deployments.trackingOnly")}</p>}
      {linked && (error || !proof) && (
        <p role="alert">{t("deployments.proofUnavailable")}</p>
      )}
      {linked && !error && proof && (
        <>
          <p>{t("deployments.historicalProof")}</p>
          <dl>
            <dt>{t("deployments.proofId")}</dt>
            <dd>{proof.id}</dd>
            <dt>{t("deployments.evaluated")}</dt>
            <dd>{proof.evaluatedAt}</dd>
            <dt>{t("deployments.expires")}</dt>
            <dd>{proof.expiresAt}</dd>
            <dt>{t("deployments.historicalGate")}</dt>
            <dd>{t(`deployments.gate.${proof.evaluation.reason}`)}</dd>
          </dl>
          {proof.override ? (
            <>
              <h4>{t("deployments.override")}</h4>
              <p>
                {t("deployments.responder")}: {proof.override.responderId}
              </p>
              <blockquote>{proof.override.reason}</blockquote>
            </>
          ) : (
            <p>{t("deployments.noOverride")}</p>
          )}
        </>
      )}
    </section>
  );
}
