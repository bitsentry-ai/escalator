import { randomUUID } from "node:crypto";

const identifier = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
export class HookError extends Error {}
const fail = (message) => {
  throw new HookError(message);
};
export function endpoint(raw) {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    fail("Use HTTPS, or loopback HTTP for a disposable manual test");
  if (!url.pathname.replace(/\/$/, "").endsWith("/deploys"))
    fail("Expected a deployment API base URL");
  return url.href.replace(/\/$/, "");
}
function json(value, limit = 8192) {
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > limit)
    fail("Request exceeds the deployment byte limit");
  return result;
}
/** No automatic redirect, unlimited retry, response-body logging or provider invocation. */
export function transport(
  base,
  token,
  fetcher = fetch,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  base = endpoint(base);
  if (!/^edp_[A-Za-z0-9_-]{43}$/.test(token ?? ""))
    fail("Invalid deployment grant");
  return async (path, key, body) => {
    const payload = json(body);
    // The same serialized bytes and idempotency key are retained across transport retries.
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetcher(base + path, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: payload,
        });
      } catch {
        if (attempt < 2) {
          await pause(1000 * (attempt + 1));
          continue;
        }
        fail(
          "Deployment request outcome is unknown; reconcile before a new attempt",
        );
      }
      if ([429, 503].includes(response.status) && attempt < 2) {
        await response.body?.cancel();
        await pause(1000 * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        fail(
          `Deployment API did not confirm the request (HTTP ${response.status})`,
        );
      }
      if (
        !(response.headers.get("content-type") ?? "")
          .toLowerCase()
          .startsWith("application/json")
      ) {
        await response.body?.cancel();
        fail("Deployment API did not return JSON");
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.byteLength;
        if (bytes > 65536) {
          fail("Deployment API response exceeds the client limit");
        }
        chunks.push(chunk);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        fail("Deployment API returned invalid JSON");
      }
    }
  };
}
export function initialSession(baseUrl, event, key = randomUUID()) {
  if (!identifier(key) || key.length > 100) fail("Invalid session key");
  if (
    event?.version !== 1 ||
    typeof event.source !== "string" ||
    !event.source ||
    typeof event.externalId !== "string" ||
    !event.externalId ||
    typeof event.environmentId !== "string" ||
    !event.environmentId ||
    typeof event.actor !== "string" ||
    !event.actor ||
    typeof event.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    (typeof event.commit !== "string" && typeof event.artifact !== "string") ||
    Object.keys(event).some(
      (k) =>
        ![
          "version",
          "source",
          "externalId",
          "environmentId",
          "actor",
          "commit",
          "artifact",
          "occurredAt",
        ].includes(k),
    )
  )
    fail("Invalid deployment start intent");
  json(event);
  return {
    version: 1,
    baseUrl: endpoint(baseUrl),
    key,
    event: structuredClone(event),
    startBody: null,
    deploymentId: null,
    finishBody: null,
    finished: false,
  };
}
/** save must atomically persist each intent before send, including after an ambiguous timeout. */
export async function begin(session, send, save) {
  if (session.finished || session.finishBody)
    fail("This session already has a finish intent");
  if (!session.startBody) {
    const { version, source, externalId, environmentId } = session.event;
    const result = await send("/preflight", `${session.key}:preflight`, {
      version,
      source,
      externalId,
      environmentId,
    });
    if (result?.decision !== "allow" || !identifier(result?.proof?.id))
      fail("Coverage did not allow this deployment");
    session.startBody = {
      ...session.event,
      coverageDecisionId: result.proof.id,
    };
    await save(session);
  }
  const result = await send(
    "/start",
    `${session.key}:start`,
    session.startBody,
  );
  if (
    !["accepted", "duplicate"].includes(result?.state) ||
    !identifier(result?.deploymentId) ||
    result.status !== "STARTED" ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 1 ||
    result.coverageDecisionId !== session.startBody.coverageDecisionId
  )
    fail("Deployment start was not confirmed as active");
  if (session.deploymentId && session.deploymentId !== result.deploymentId)
    fail("Deployment identity changed");
  session.deploymentId = result.deploymentId;
  await save(session);
  return session.deploymentId;
}
export async function finish(
  session,
  outcome,
  send,
  save,
  now = () => new Date().toISOString(),
) {
  if (
    !identifier(session.deploymentId) ||
    !["SUCCEEDED", "FAILED", "CANCELLED"].includes(outcome)
  )
    fail("A confirmed start and explicit terminal outcome are required");
  if (session.finishBody && session.finishBody.outcome !== outcome)
    fail("Do not replace the original finish outcome");
  if (!session.finishBody) {
    const { version, source, externalId, environmentId, actor } = session.event;
    session.finishBody = {
      version,
      source,
      externalId,
      environmentId,
      actor,
      occurredAt: now(),
      outcome,
    };
    await save(session);
  }
  const result = await send(
    `/${encodeURIComponent(session.deploymentId)}/finish`,
    `${session.key}:finish`,
    session.finishBody,
  );
  if (
    !["accepted", "duplicate"].includes(result?.state) ||
    result.deploymentId !== session.deploymentId ||
    ![outcome, "TIMED_OUT"].includes(result.status) ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 1
  )
    fail("Deployment finish was not confirmed");
  session.finished = true;
  await save(session);
  return session.deploymentId;
}
