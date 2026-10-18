import test from "node:test";
import assert from "node:assert/strict";
import { PushoverChannel } from "../src/adapters/channels/pushover.js";
import { WebhookChannel } from "../src/adapters/channels/webhook.js";
import type { ChannelHttpTransport } from "../src/adapters/channels/ports.js";
import type {
  SecretStore,
  SecretUse,
} from "../src/application/ports/secrets.js";
import { workspaceIdSchema } from "../src/contracts/index.js";
const appToken = "a".repeat(30),
  userKey = "u".repeat(30),
  receiptId = "r".repeat(30);
const notification = {
  deliveryId: "delivery-1",
  title: "API unavailable",
  message: "Probe failed",
  acknowledgementUrl: "https://ops.example/ack#token=transient-token",
};
function fixture(
  value: unknown,
  responses: Array<{ status: number; body: string } | Error>,
  after = false,
) {
  const requests: Parameters<ChannelHttpTransport["send"]>[0][] = [];
  const secrets: SecretStore = {
    async withSecret(_use, consume) {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      try {
        const result = await consume(bytes);
        if (after) throw new Error("Lease lost with secret data");
        return result;
      } finally {
        bytes.fill(0);
      }
    },
  };
  const http: ChannelHttpTransport = {
    async send(request) {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("No fixture response");
      if (response instanceof Error) throw response;
      return response;
    },
  };
  const use: SecretUse = {
    workspaceId: workspaceIdSchema.parse("org_first"),
    secretId: "secret",
    queue: "outbox",
    workId: "work",
    claimToken: "claim",
    signal: new AbortController().signal,
  };
  return { requests, secrets, http, use };
}
const accepted = {
  status: 200,
  body: JSON.stringify({
    status: 1,
    request: "fixture-request",
    receipt: receiptId,
  }),
};
const credential = { token: appToken, user: userKey };
const timing = { retrySeconds: 60, expireSeconds: 120 };

test("Pushover returns only receipt output and snapshots retry configuration", async () => {
  const f = fixture(credential, [accepted]);
  const settings = { ...timing };
  const channel = new PushoverChannel(f.secrets, f.http, settings);
  settings.expireSeconds = 99999;
  const result = await channel.send(notification, f.use);
  assert.deepEqual(result, { outcome: "accepted", receiptId });
  assert.equal(JSON.stringify(result).includes(appToken), false);
  assert.equal(JSON.stringify(result).includes("transient-token"), false);
  const body = new URLSearchParams(f.requests[0].body);
  assert.equal(body.get("priority"), "2");
  assert.equal(body.get("retry"), "60");
  assert.equal(body.get("expire"), "120");
  assert.equal(body.get("user"), userKey);
  assert.equal(body.get("url"), notification.acknowledgementUrl);
});
test("Pushover ambiguous outcomes stay unknown, including loss after provider acceptance", async () => {
  for (const response of [
    new Error("sensitive URL and token"),
    { status: 503, body: "temporary" },
    { status: 200, body: '{"status":1}' },
    { status: 200, body: "{" },
    { status: 200, body: "x".repeat(65537) },
  ]) {
    const f = fixture(credential, [response]);
    assert.deepEqual(
      await new PushoverChannel(f.secrets, f.http, timing).send(
        notification,
        f.use,
      ),
      { outcome: "unknown", retryable: true },
    );
  }
  const f = fixture(credential, [accepted], true);
  assert.deepEqual(
    await new PushoverChannel(f.secrets, f.http, timing).send(
      notification,
      f.use,
    ),
    { outcome: "unknown", retryable: true },
  );
});
test("Pushover rejects invalid configuration and explicit provider rejection", async () => {
  const f = fixture({ ...credential, token: "bad" }, []);
  assert.deepEqual(
    await new PushoverChannel(f.secrets, f.http, timing).send(
      notification,
      f.use,
    ),
    { outcome: "rejected", retryable: false, reason: "invalid_configuration" },
  );
  assert.equal(f.requests.length, 0);
  for (const status of [200, 400, 429]) {
    const failed = fixture(credential, [
      { status, body: '{"status":0,"errors":["do not persist this"]}' },
    ]);
    assert.deepEqual(
      await new PushoverChannel(failed.secrets, failed.http, timing).send(
        notification,
        failed.use,
      ),
      {
        outcome: "rejected",
        retryable: status === 429,
        reason: "provider_rejected",
      },
    );
  }
  assert.throws(
    () =>
      new PushoverChannel(f.secrets, f.http, {
        retrySeconds: 1,
        expireSeconds: 120,
      }),
  );
});
test("Pushover acknowledges only a matching user through the authenticated receipt API", async () => {
  for (const [acknowledged, by, expired, state] of [
    [1, userKey, 0, "acknowledged"],
    [1, "other", 0, "unknown"],
    [0, "", 0, "pending"],
    [0, "", 1, "expired"],
  ] as const) {
    const f = fixture(credential, [
      {
        status: 200,
        body: JSON.stringify({
          status: 1,
          acknowledged,
          acknowledged_by: by,
          acknowledged_at: acknowledged ? 1700000000 : 0,
          expired,
        }),
      },
    ]);
    const result = await new PushoverChannel(f.secrets, f.http, timing).inspect(
      receiptId,
      f.use,
    );
    assert.equal(result.state, state);
    assert.equal(JSON.stringify(result).includes(userKey), false);
    assert.equal(
      new URL(f.requests[0].url).searchParams.get("token"),
      appToken,
    );
  }
  const f = fixture(credential, []);
  assert.deepEqual(
    await new PushoverChannel(f.secrets, f.http, timing).inspect(
      "../bad",
      f.use,
    ),
    { state: "unknown" },
  );
  assert.equal(f.requests.length, 0);
});
test("delivery tags cancel unknown accepted attempts without a receipt and separate tenants", async () => {
  const f = fixture(credential, [
    new Error("lost response"),
    { status: 200, body: '{"status":1}' },
    accepted,
  ]);
  const channel = new PushoverChannel(f.secrets, f.http, timing);
  assert.equal((await channel.send(notification, f.use)).outcome, "unknown");
  assert.equal(
    await channel.cancel(notification.deliveryId, f.use),
    "cancelled",
  );
  const firstTag = new URLSearchParams(f.requests[0].body).get("tags");
  assert.equal(
    new URL(f.requests[1].url).pathname,
    `/1/receipts/cancel_by_tag/${firstTag}.json`,
  );
  await channel.send(notification, {
    ...f.use,
    workspaceId: workspaceIdSchema.parse("org_other"),
  });
  assert.notEqual(
    new URLSearchParams(f.requests[2].body).get("tags"),
    firstTag,
  );
});
test("webhook uses a stable idempotency key and returns no provider body", async () => {
  const f = fixture(
    { url: "https://hooks.example/oncall", bearerToken: "private-token" },
    [{ status: 202, body: "arbitrary provider content" }],
  );
  const result = await new WebhookChannel(f.secrets, f.http).send(
    notification,
    f.use,
  );
  assert.deepEqual(result, { outcome: "accepted", receiptId: null });
  assert.equal(
    f.requests[0].headers["idempotency-key"],
    notification.deliveryId,
  );
  assert.equal(f.requests[0].headers.authorization, "Bearer private-token");
  assert.equal(
    JSON.parse(f.requests[0].body!).acknowledgementUrl,
    notification.acknowledgementUrl,
  );
});
test("webhook classifies rejection, unknown acceptance and redirects without another request", async () => {
  for (const [status, outcome, retryable] of [
    [401, "rejected", false],
    [429, "rejected", true],
    [408, "unknown", true],
    [503, "unknown", true],
    [302, "unknown", true],
  ] as const) {
    const f = fixture({ url: "https://hooks.example/oncall" }, [
      { status, body: "" },
    ]);
    const result = await new WebhookChannel(f.secrets, f.http).send(
      notification,
      f.use,
    );
    assert.equal(result.outcome, outcome);
    assert.equal(result.retryable, retryable);
    assert.equal(f.requests.length, 1);
  }
});
test("webhook rejects credential URLs and header injection before network access", async () => {
  for (const value of [
    { url: "http://hooks.example" },
    { url: "https://user:password@hooks.example" },
    { url: "https://hooks.example/#fragment" },
    { url: "https://hooks.example", bearerToken: "bad\r\nheader" },
  ]) {
    const f = fixture(value, []);
    assert.equal(
      (await new WebhookChannel(f.secrets, f.http).send(notification, f.use))
        .outcome,
      "rejected",
    );
    assert.equal(f.requests.length, 0);
  }
});
