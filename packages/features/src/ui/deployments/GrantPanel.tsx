import { useCallback, useEffect, useRef, useState } from "react";
import {
  issueDeploymentTokenSchema,
  type DeploymentTarget,
  type DeploymentGrantSummary,
} from "../../contracts/index.js";
import type { DeploymentSettingsClient } from "../deployment-settings-client.js";
import type { ProbePageInput } from "../probes-client.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
type Text = (key: string) => string;
export function GrantPanel({
  client,
  target,
  canActivate,
  t,
}: {
  client: DeploymentSettingsClient;
  target: DeploymentTarget;
  canActivate: boolean;
  t: Text;
}) {
  const fetch = useCallback(
    (input: ProbePageInput) => client.grants({ targetId: target.id, ...input }),
    [client, target.id],
  );
  const respondersFetch = useCallback(
    (input: ProbePageInput) => client.responders(input),
    [client],
  );
  const grants = useIncidentCollection(fetch),
    responders = useIncidentCollection(respondersFetch);
  const [read, setRead] = useState(true),
    [write, setWrite] = useState(false),
    [mapped, setMapped] = useState(""),
    [days, setDays] = useState("30");
  const [issued, setIssued] = useState<{
    client: DeploymentSettingsClient;
    targetId: string;
    value: DeploymentGrantSummary & { token: string };
  }>();
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [copyError, setCopyError] = useState(false);
  const generation = useRef(0),
    busy = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [client, target.id],
  );
  async function issue() {
    if (busy.current || !target.enabled || (write && !canActivate)) return;
    const parsed = issueDeploymentTokenSchema.safeParse({
      targetId: target.id,
      capabilities: [
        ...(read ? ["deployment:read"] : []),
        ...(write ? ["deployment:write"] : []),
      ],
      mappedDeployerId: mapped || null,
      ttlSeconds: Number(days) * 86400,
    });
    if (!parsed.success || !Number.isInteger(Number(days))) {
      setError("deploymentSetup.invalid");
      return;
    }
    busy.current = true;
    setPending(true);
    setError(undefined);
    setIssued(undefined);
    setCopyError(false);
    const current = generation.current;
    try {
      const value = await client.issue(parsed.data);
      if (current === generation.current) {
        setIssued({ client, targetId: target.id, value });
        grants.refresh();
      }
    } catch {
      if (current === generation.current) {
        setError("deploymentSetup.issueUnknown");
        grants.refresh();
      }
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  async function revoke(id: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    const current = generation.current;
    try {
      await client.revoke({ targetId: target.id, id });
      if (current === generation.current) {
        setIssued((old) => (old?.value.id === id ? undefined : old));
        grants.refresh();
      }
    } catch {
      if (current === generation.current)
        setError("deploymentSetup.revokeError");
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  const secret =
    issued?.client === client && issued.targetId === target.id
      ? issued.value
      : undefined;
  return (
    <section style={styles.card} aria-label={t("deploymentSetup.grants")}>
      <h3>{t("deploymentSetup.grants")}</h3>
      <p>{t("deploymentSetup.grantGuidance")}</p>
      {error && <p role="alert">{t(error)}</p>}
      {secret && (
        <div>
          <p>{t("deploymentSetup.oneTime")}</p>
          <label style={styles.label}>
            {t("deploymentSetup.token")}
            <textarea
              style={styles.input}
              readOnly
              autoComplete="off"
              spellCheck={false}
              value={secret.token}
            />
          </label>
          <p>
            {secret.id} · {t("deployments.expires")}: {secret.expiresAt}
          </p>
          <button
            type="button"
            style={styles.button}
            onClick={() => {
              const current = generation.current;
              setCopyError(false);
              void Promise.resolve()
                .then(() => {
                  if (current === generation.current)
                    return navigator.clipboard.writeText(secret.token);
                })
                .catch(() => {
                  if (current === generation.current) setCopyError(true);
                });
            }}
          >
            {t("deploymentSetup.copy")}
          </button>
          <button
            type="button"
            style={styles.button}
            onClick={() => {
              setIssued(undefined);
              setCopyError(false);
            }}
          >
            {t("deploymentSetup.hide")}
          </button>
          {copyError && <p role="alert">{t("deploymentSetup.copyError")}</p>}
        </div>
      )}
      {!target.enabled && <p>{t("deploymentSetup.disabledTarget")}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void issue();
        }}
      >
        <fieldset style={styles.form} disabled={pending || !target.enabled}>
          <legend>{t("deploymentSetup.issue")}</legend>
          <label>
            <input
              type="checkbox"
              checked={read}
              onChange={(e) => setRead(e.target.checked)}
            />
            {t("deploymentSetup.read")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={write}
              disabled={!canActivate && !write}
              onChange={(e) => setWrite(e.target.checked)}
            />
            {t("deploymentSetup.write")}
          </label>
          {!canActivate && <p>{t("deploymentSetup.unavailable")}</p>}
          <label style={styles.label}>
            {t("deploymentSetup.deployer")}
            <select
              style={styles.input}
              value={mapped}
              onChange={(e) => setMapped(e.target.value)}
            >
              <option value="">{t("deploymentSetup.unmapped")}</option>
              {responders.items
                .filter((r) => r.enabled && r.role !== "viewer")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName}
                  </option>
                ))}
            </select>
          </label>
          {write && !mapped && <p>{t("deploymentSetup.unmappedWarning")}</p>}
          {responders.error && (
            <p role="alert">{t("deploymentSetup.optionsError")}</p>
          )}
          {responders.error && (
            <button
              type="button"
              style={styles.button}
              onClick={responders.refresh}
            >
              {t("sources.refresh")}
            </button>
          )}
          {responders.next && (
            <button
              type="button"
              style={styles.button}
              disabled={responders.loading}
              onClick={() => void responders.more()}
            >
              {t("deployments.more")}
            </button>
          )}
          <label style={styles.label}>
            {t("deploymentSetup.days")}
            <input
              style={styles.input}
              type="number"
              required
              min={1}
              max={90}
              step={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </label>
          <button
            style={styles.button}
            type="submit"
            disabled={write && !canActivate}
          >
            {t("deploymentSetup.issue")}
          </button>
        </fieldset>
      </form>
      <button
        style={styles.button}
        type="button"
        disabled={grants.loading || pending}
        onClick={grants.refresh}
      >
        {t("sources.refresh")}
      </button>
      {grants.loading && <p role="status">{t("sources.loading")}</p>}
      {grants.error && (
        <p role="alert">{t("deploymentSetup.inventoryError")}</p>
      )}
      <ul>
        {grants.items.map((grant) => (
          <li key={grant.id}>
            <p>
              {grant.id} ·{" "}
              {grant.capabilities
                .map((c) =>
                  t(
                    c === "deployment:read"
                      ? "deploymentSetup.read"
                      : "deploymentSetup.write",
                  ),
                )
                .join(", ")}
            </p>
            <p>
              {t("deploymentSetup.deployer")}:{" "}
              {grant.mappedDeployerId ?? t("deploymentSetup.unmapped")} ·{" "}
              {t("deployments.expires")}: {grant.expiresAt}
            </p>
            {grant.revokedAt ? (
              <p>
                {t("deploymentSetup.revoked")}: {grant.revokedAt}
              </p>
            ) : (
              <button
                type="button"
                style={styles.button}
                disabled={pending}
                onClick={() => void revoke(grant.id)}
              >
                {t("deploymentSetup.revoke")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {grants.next && (
        <button
          type="button"
          style={styles.button}
          disabled={grants.loading || pending}
          onClick={() => void grants.more()}
        >
          {t("deployments.more")}
        </button>
      )}
    </section>
  );
}
