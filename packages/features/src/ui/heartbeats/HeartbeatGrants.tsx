import { useCallback, useEffect, useRef, useState } from "react";
import type { Heartbeat } from "../../contracts/index.js";
import { issueHeartbeatGrantSchema } from "../../contracts/index.js";
import type { HeartbeatsClient } from "../heartbeats-client.js";
import type { ProbePageInput } from "../probes-client.js";
import { useIncidentCollection as useCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
/** Mounted only for administrators. Issued values live only in this component's memory. */
export function HeartbeatGrants({
  source,
  client,
  t,
}: {
  source: Heartbeat;
  client: HeartbeatsClient;
  t: (key: string) => string;
}) {
  const fetch = useCallback(
    (page: ProbePageInput) => client.grants({ ...page, id: source.id }),
    [client, source.id],
  );
  const grants = useCollection(fetch);
  const [issued, setIssued] = useState<{ value: string; expiresAt: string }>();
  const [days, setDays] = useState("30");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    generation.current++;
    busy.current = false;
    setIssued(undefined);
    setPending(false);
    setError(false);
    return () => {
      generation.current++;
    };
  }, [client, source.id]);
  async function write(id?: string) {
    if (busy.current) return;
    const current = generation.current;
    busy.current = true;
    setPending(true);
    setError(false);
    setIssued(undefined);
    try {
      if (id) await client.revokeGrant({ id: source.id, grantId: id });
      else {
        const duration = Number(days);
        if (!Number.isInteger(duration) || duration < 1 || duration > 90)
          throw new Error("Invalid validity");
        const input = issueHeartbeatGrantSchema.parse({
          id: source.id,
          expiresAt: new Date(Date.now() + duration * 86400000).toISOString(),
        });
        const result = await client.issueGrant(input);
        if (current === generation.current)
          setIssued({ value: result.token, expiresAt: result.expiresAt });
      }
      if (current === generation.current) grants.refresh();
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  return (
    <section style={styles.card}>
      <h3>{t("sources.grants")}</h3>
      <p>{t("heartbeats.grantHelp")}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void write();
        }}
      >
        <fieldset disabled={pending}>
          <label>
            {t("sources.expiryDays")}{" "}
            <input
              type="number"
              min={1}
              max={90}
              step={1}
              required
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
          </label>
          <button style={styles.button} type="submit">
            {t("sources.issue")}
          </button>
        </fieldset>
      </form>
      {issued && (
        <aside>
          <p>{t("sources.once")}</p>
          <input
            aria-label={t("sources.token")}
            value={issued.value}
            readOnly
            autoComplete="off"
            spellCheck={false}
          />
          <p>
            {t("sources.expires")}{" "}
            <time dateTime={issued.expiresAt}>{issued.expiresAt}</time>
          </p>
          <button style={styles.button} onClick={() => setIssued(undefined)}>
            {t("sources.dismiss")}
          </button>
        </aside>
      )}
      {(error || grants.error) && <p role="alert">{t("sources.error")}</p>}
      {(pending || grants.loading) && (
        <p role="status">{t("sources.loading")}</p>
      )}
      <button
        style={styles.button}
        disabled={pending || grants.loading}
        onClick={grants.refresh}
      >
        {t("sources.refresh")}
      </button>
      <ul>
        {grants.items.map((grant) => (
          <li key={grant.id}>
            {grant.id} · {t("sources.expires")}{" "}
            <time dateTime={grant.expiresAt}>{grant.expiresAt}</time>
            {grant.revokedAt ? (
              <>
                {" "}
                · {t("sources.revoked")}{" "}
                <time dateTime={grant.revokedAt}>{grant.revokedAt}</time>
              </>
            ) : (
              <button
                style={styles.button}
                disabled={pending}
                onClick={() => void write(grant.id)}
              >
                {t("sources.revoke")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {grants.next && (
        <button
          style={styles.button}
          disabled={pending || grants.loading}
          onClick={() => void grants.more()}
        >
          {t("sources.moreGrants")}
        </button>
      )}
    </section>
  );
}
