import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  stat,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initialSession,
  endpoint,
  transport,
  begin,
  finish,
} from "../docs/hooks/client.mjs";
import { main, withState } from "../docs/hooks/hook.mjs";
const base = "https://escalator.example.test/v1/deploys";
const event = {
  version: 1,
  source: "ci",
  externalId: "run-1-attempt-1",
  environmentId: "prod",
  actor: "ci",
  commit: "abc",
  artifact: null,
  occurredAt: "2026-10-05T00:00:00.000Z",
};
const state = () => initialSession(base, event, "session-one");
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const started = {
  state: "accepted",
  deploymentId: "deployment",
  status: "STARTED",
  revision: 1,
  coverageDecisionId: "proof",
};

test("protected begin persists the proof before sending start and retries identical intent after an unknown outcome", async () => {
  const session = state(),
    saved = [],
    calls = [];
  let unknown = true;
  const send = async (path, key, body) => {
    calls.push([path, key, structuredClone(body)]);
    if (path === "/preflight")
      return { decision: "allow", proof: { id: "proof" } };
    assert.equal(saved.at(-1).startBody.coverageDecisionId, "proof");
    if (unknown) {
      unknown = false;
      throw new Error("transport interrupted");
    }
    return started;
  };
  const save = async (value) => saved.push(structuredClone(value));
  await assert.rejects(begin(session, send, save));
  await begin(session, send, save);
  assert.equal(calls.filter(([path]) => path === "/preflight").length, 1);
  assert.deepEqual(calls[1], calls[2]);
  assert.equal(session.deploymentId, "deployment");
});

test("an HTTP-200 blocked or malformed preflight never sends start", async () => {
  for (const result of [
    { decision: "block", proof: { id: "proof" } },
    { decision: "allow" },
    null,
  ]) {
    let calls = 0;
    await assert.rejects(
      begin(
        state(),
        async (path) => {
          calls++;
          assert.equal(path, "/preflight");
          return result;
        },
        async () => {},
      ),
      /Coverage/,
    );
    assert.equal(calls, 1);
  }
});

test("a finish intent keeps its timestamp and outcome on retry and cannot be rewritten", async () => {
  const session = state();
  session.deploymentId = "deployment";
  const calls = [];
  let fail = true;
  const send = async (...args) => {
    calls.push(structuredClone(args));
    if (fail) {
      fail = false;
      throw new Error("timeout");
    }
    return {
      state: "duplicate",
      deploymentId: "deployment",
      status: "SUCCEEDED",
      revision: 2,
    };
  };
  const save = async () => {};
  await assert.rejects(
    finish(session, "SUCCEEDED", send, save, () => event.occurredAt),
  );
  await finish(session, "SUCCEEDED", send, save, () => "2026-10-06T00:00:00Z");
  assert.deepEqual(calls[0], calls[1]);
  await assert.rejects(finish(session, "FAILED", send, save));
  await assert.rejects(begin(session, send, save));
  assert.equal(calls.length, 2);
});

test("transport retries byte-identical requests, refuses redirects and never includes a response body in an error", async () => {
  const calls = [];
  const send = transport(
    base,
    `edp_${"a".repeat(43)}`,
    async (url, options) => {
      calls.push([url, options]);
      return calls.length < 3
        ? response({ private: "sensitive" }, 503)
        : response(started);
    },
    async () => {},
  );
  assert.deepEqual(await send("/start", "key", event), started);
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      ([, options]) =>
        options.redirect === "manual" &&
        options.body === calls[0][1].body &&
        options.headers["Idempotency-Key"] === "key",
    ),
  );
  const redirect = transport(base, `edp_${"a".repeat(43)}`, async () =>
    response({ private: "sensitive" }, 302),
  );
  await assert.rejects(
    redirect("/start", "key", event),
    (error) =>
      error.message.includes("302") && !error.message.includes("sensitive"),
  );
});

test("transport bounds request and response bytes and does not trust malformed JSON", async () => {
  let calls = 0;
  const token = `edp_${"a".repeat(43)}`;
  const send = transport(base, token, async () => {
    calls++;
    return response({ value: "x".repeat(65536) });
  });
  await assert.rejects(send("/start", "key", { value: "x".repeat(8192) }));
  assert.equal(calls, 0);
  await assert.rejects(send("/start", "key", event), /client limit/);
  const invalid = transport(
    base,
    token,
    async () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
  );
  await assert.rejects(invalid("/start", "key", event), /invalid JSON/);
  for (const url of [
    "http://remote.test/v1/deploys",
    "https://user:password@example.test/v1/deploys",
    base + "?token=secret",
  ])
    assert.throws(() => endpoint(url));
  assert.equal(
    endpoint("http://127.0.0.1:3000/v1/deploys/"),
    "http://127.0.0.1:3000/v1/deploys",
  );
});

test("private state persists without a grant and rejects concurrent invocations and symlink files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escalator-hooks-"));
  try {
    const file = join(dir, "session.json");
    await withState(file, async (prior, save) => {
      assert.equal(prior, null);
      await save(state());
      await assert.rejects(
        withState(file, async () => {}),
        /locked/,
      );
    });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const raw = await readFile(file, "utf8");
    assert.equal(raw.includes("edp_"), false);
    await withState(file, async (prior) => assert.deepEqual(prior, state()));
    const target = join(dir, "other.json");
    await writeFile(target, "{}", { mode: 0o600 });
    const alias = join(dir, "alias.json");
    await symlink(target, alias);
    await assert.rejects(withState(alias, async () => {}));
    assert.equal(await readFile(target, "utf8"), "{}");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI resumes its private state, rejects a changed release and sends finish only with an explicit outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escalator-hook-cli-"));
  const env = {
    ESCALATOR_URL: base,
    ESCALATOR_TOKEN: `edp_${"a".repeat(43)}`,
    ESCALATOR_SOURCE: "ci",
    ESCALATOR_RUN_ID: "attempt-one",
    ESCALATOR_ENVIRONMENT: "prod",
    ESCALATOR_ACTOR: "ci",
    ESCALATOR_COMMIT: "abc",
    ESCALATOR_STATE: join(dir, "session.json"),
  };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push([url, options.body, options.headers["Idempotency-Key"]]);
    if (url.endsWith("/preflight"))
      return response({ decision: "allow", proof: { id: "proof" } });
    if (url.endsWith("/start")) return response(started);
    return response({
      state: "accepted",
      deploymentId: "deployment",
      status: "SUCCEEDED",
      revision: 2,
    });
  };
  try {
    assert.equal(await main(["begin"], env, fetcher), "deployment");
    await assert.rejects(
      main(["begin"], { ...env, ESCALATOR_COMMIT: "different" }, fetcher),
      /original deployment intent/,
    );
    assert.equal(await main(["begin"], env, fetcher), "deployment");
    assert.deepEqual(calls[1], calls[2]);
    assert.equal(
      await main(["finish", "SUCCEEDED"], env, fetcher),
      "deployment",
    );
    await assert.rejects(main(["finish", "FAILED"], env, fetcher));
    assert.equal(calls.length, 4);
    assert.equal(
      (await readFile(env.ESCALATOR_STATE, "utf8")).includes(
        env.ESCALATOR_TOKEN,
      ),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hook request bodies and idempotency keys conform to the compiled machine API contracts", async () => {
  const require = createRequire(
    new URL("../apps/server/package.json", import.meta.url),
  );
  const contracts = require("@bitsentry-escalator/features/contracts");
  const session = state();
  const send = async (path, key, body) => {
    contracts.deploymentIdempotencyKeySchema.parse(key);
    if (path === "/preflight") {
      contracts.deploymentPreflightInputSchema.parse(body);
      return { decision: "allow", proof: { id: "proof" } };
    }
    if (path === "/start") {
      contracts.deploymentStartInputSchema.parse(body);
      return contracts.deploymentReceiptResultSchema.parse(started);
    }
    contracts.deploymentFinishInputSchema.parse(body);
    return contracts.deploymentReceiptResultSchema.parse({
      state: "accepted",
      deploymentId: "deployment",
      status: "SUCCEEDED",
      revision: 2,
    });
  };
  await begin(session, send, async () => {});
  await finish(
    session,
    "SUCCEEDED",
    send,
    async () => {},
    () => event.occurredAt,
  );
});

test("a symlink invocation cannot silently skip the CLI coverage gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escalator-hook-entry-"));
  try {
    const link = join(dir, "hook.mjs");
    await symlink(
      fileURLToPath(new URL("../docs/hooks/hook.mjs", import.meta.url)),
      link,
    );
    await symlink(
      fileURLToPath(new URL("../docs/hooks/client.mjs", import.meta.url)),
      join(dir, "client.mjs"),
    );
    for (const flags of [[], ["--preserve-symlinks-main"]]) {
      // No action or environment is supplied: this must execute usage validation,
      // never network I/O, and must not return a false successful gate exit.
      const result = spawnSync(process.execPath, [...flags, link], {
        encoding: "utf8",
        env: {},
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Usage:/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
