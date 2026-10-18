import test from "node:test";
import assert from "node:assert/strict";
import { NtfyChannel } from "../src/adapters/channels/ntfy.js";
import { SlackChannel } from "../src/adapters/channels/slack.js";
import { DiscordChannel } from "../src/adapters/channels/discord.js";
import type {
  ChannelHttpTransport,
  NotificationChannel,
} from "../src/adapters/channels/ports.js";
import type {
  SecretStore,
  SecretUse,
} from "../src/application/ports/secrets.js";
import { workspaceIdSchema } from "../src/contracts/index.js";
const notification = {
  deliveryId: "delivery-1",
  title: "API unavailable",
  message: "Probe failed",
  acknowledgementUrl: "https://ops.example/ack#token=transient-token",
};
const slackUrl = "https://hooks.slack.com/services/TTEAM/BAPP/secret";
const discordUrl =
  "https://discord.com/api/webhooks/123456789012345678/secret_token_123456789";
type Provider = {
  name: string;
  credentials: unknown;
  accepted: string;
  invalid: unknown;
  create(secrets: SecretStore, http: ChannelHttpTransport): NotificationChannel;
};
const providers: Provider[] = [
  {
    name: "ntfy",
    credentials: {
      url: "https://ntfy.example/",
      topic: "private-topic",
      bearerToken: "private-token",
    },
    accepted: JSON.stringify({
      event: "message",
      id: "receipt",
      topic: "private-topic",
    }),
    invalid: { url: "http://ntfy.example", topic: "topic" },
    create: (s, h) => new NtfyChannel(s, h),
  },
  {
    name: "Slack",
    credentials: { url: slackUrl },
    accepted: "ok",
    invalid: { url: "https://example.test/services/TTEAM/BAPP/secret" },
    create: (s, h) => new SlackChannel(s, h),
  },
  {
    name: "Discord",
    credentials: { url: discordUrl },
    accepted: JSON.stringify({
      id: "234567890123456789",
      webhook_id: "123456789012345678",
    }),
    invalid: { url: discordUrl + "?wait=false" },
    create: (s, h) => new DiscordChannel(s, h),
  },
];
function fixture(
  provider: Provider,
  response: { status: number; body: string } | Error,
  options: {
    credentials?: unknown;
    after?: boolean;
    cancelDuring?: boolean;
  } = {},
) {
  const requests: Parameters<ChannelHttpTransport["send"]>[0][] = [];
  const controller = new AbortController();
  let secretCalls = 0;
  const use: SecretUse = {
    workspaceId: workspaceIdSchema.parse("org_one"),
    secretId: "secret",
    queue: "outbox",
    workId: "work",
    claimToken: "claim",
    signal: controller.signal,
  };
  const secrets: SecretStore = {
    withSecret: async (request, consume) => {
      secretCalls++;
      assert.equal(request, use);
      const bytes = new TextEncoder().encode(
        JSON.stringify(options.credentials ?? provider.credentials),
      );
      try {
        const result = await consume(bytes);
        if (options.after) throw new Error("private-token lease expired");
        return result;
      } finally {
        bytes.fill(0);
      }
    },
  };
  const http: ChannelHttpTransport = {
    send: async (request) => {
      requests.push({ ...request, headers: { ...request.headers } });
      if (options.cancelDuring) controller.abort();
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return {
    channel: provider.create(secrets, http),
    requests,
    use,
    controller,
    secretCalls: () => secretCalls,
  };
}
for (const provider of providers) {
  test(`${provider.name}: confirmed provider response is accepted without leaking transient values`, async () => {
    const f = fixture(provider, { status: 200, body: provider.accepted });
    const result = await f.channel.send(notification, f.use);
    assert.deepEqual(result, { outcome: "accepted", receiptId: null });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, "POST");
    assert.equal(f.requests[0].signal, f.use.signal);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(JSON.stringify(result).includes("transient-token"), false);
  });
  test(`${provider.name}: rejects invalid credentials without a network attempt`, async () => {
    const f = fixture(
      provider,
      { status: 200, body: provider.accepted },
      { credentials: provider.invalid },
    );
    assert.deepEqual(await f.channel.send(notification, f.use), {
      outcome: "rejected",
      retryable: false,
      reason: "invalid_configuration",
    });
    assert.equal(f.requests.length, 0);
  });
  test(`${provider.name}: transport ambiguity and unexpected success bodies stay unknown`, async () => {
    for (const response of [
      new Error("private-token in URL"),
      { status: 503, body: "private" },
      { status: 408, body: "timeout" },
      { status: 302, body: "redirect" },
      { status: 200, body: "wrong" },
      { status: 204, body: "" },
      { status: 200, body: "x".repeat(65537) },
    ]) {
      const f = fixture(provider, response);
      assert.deepEqual(await f.channel.send(notification, f.use), {
        outcome: "unknown",
        retryable: true,
      });
    }
    const f = fixture(
      provider,
      { status: 200, body: provider.accepted },
      { after: true },
    );
    assert.deepEqual(await f.channel.send(notification, f.use), {
      outcome: "unknown",
      retryable: true,
    });
  });
  test(`${provider.name}: explicit rejection distinguishes rate limiting`, async () => {
    for (const status of [400, 401, 403, 404, 422, 429]) {
      const f = fixture(provider, { status, body: "private error" });
      assert.deepEqual(await f.channel.send(notification, f.use), {
        outcome: "rejected",
        retryable: status === 429,
        reason: "provider_rejected",
      });
    }
  });
  test(`${provider.name}: cancellation before and during transport cannot produce acceptance`, async () => {
    const before = fixture(provider, { status: 200, body: provider.accepted });
    before.controller.abort();
    assert.deepEqual(await before.channel.send(notification, before.use), {
      outcome: "unknown",
      retryable: true,
    });
    assert.equal(before.secretCalls(), 0);
    assert.equal(before.requests.length, 0);
    const during = fixture(
      provider,
      { status: 200, body: provider.accepted },
      { cancelDuring: true },
    );
    assert.deepEqual(await during.channel.send(notification, during.use), {
      outcome: "unknown",
      retryable: true,
    });
  });
  test(`${provider.name}: invalid notifications and unavailable secrets have redacted results`, async () => {
    const f = fixture(provider, { status: 200, body: provider.accepted });
    assert.deepEqual(
      await f.channel.send(
        { ...notification, acknowledgementUrl: "javascript:alert(1)" },
        f.use,
      ),
      {
        outcome: "rejected",
        retryable: false,
        reason: "invalid_configuration",
      },
    );
    assert.equal(f.secretCalls(), 0);
    const secretFailure = provider.create(
      {
        withSecret: async () => {
          throw new Error("private-token");
        },
      },
      {
        send: async () => {
          throw new Error("unexpected");
        },
      },
    );
    assert.deepEqual(await secretFailure.send(notification, f.use), {
      outcome: "rejected",
      retryable: true,
      reason: "secret_unavailable",
    });
  });
}
test("ntfy sends JSON at the root with a view action and bounded UTF-8 message", async () => {
  const provider = providers[0],
    f = fixture(provider, { status: 200, body: provider.accepted });
  await f.channel.send({ ...notification, message: "😀".repeat(2048) }, f.use);
  const request = f.requests[0],
    body = JSON.parse(request.body!);
  assert.equal(request.url, "https://ntfy.example/");
  assert.equal(request.headers.authorization, "Bearer private-token");
  assert.equal(body.topic, "private-topic");
  assert.equal(body.priority, 5);
  assert.equal(body.click, notification.acknowledgementUrl);
  assert.deepEqual(body.actions, [
    {
      action: "view",
      label: "Acknowledge",
      url: notification.acknowledgementUrl,
    },
  ]);
  assert.ok(Buffer.byteLength(body.message) <= 4096);
  assert.equal(body.message.includes("�"), false);
});
test("Slack keeps untrusted incident text in plain blocks and bounds Unicode sections", async () => {
  const provider = providers[1],
    f = fixture(provider, { status: 200, body: provider.accepted });
  await f.channel.send(
    {
      ...notification,
      title: "<!channel>",
      message: "😀".repeat(2048),
      acknowledgementUrl: "https://ops.example/ack#token=x|<@U>",
    },
    f.use,
  );
  const body = JSON.parse(f.requests[0].body!);
  for (const block of body.blocks.slice(0, -1)) {
    assert.equal(block.text.type, "plain_text");
    assert.ok(block.text.text.length <= 3000);
  }
  const link = body.blocks.at(-1).text.text;
  assert.equal(link.includes("<@U>"), false);
  assert.equal(link.includes("<!channel>"), false);
  assert.equal(body.unfurl_links, false);
  assert.equal(body.unfurl_media, false);
});
test("Discord waits for confirmation, suppresses mentions and links its bounded embed", async () => {
  const provider = providers[2],
    f = fixture(provider, { status: 200, body: provider.accepted });
  await f.channel.send(
    {
      ...notification,
      title: "😀".repeat(250),
      message: "@everyone " + "x".repeat(4000),
    },
    f.use,
  );
  assert.equal(new URL(f.requests[0].url).searchParams.get("wait"), "true");
  const body = JSON.parse(f.requests[0].body!);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.embeds[0].url, notification.acknowledgementUrl);
  assert.ok(body.embeds[0].title.length <= 256);
  assert.ok(body.embeds[0].description.length <= 4096);
  const wrong = fixture(provider, {
    status: 200,
    body: JSON.stringify({
      id: "234567890123456789",
      webhook_id: "000000000000000000",
    }),
  });
  assert.deepEqual(await wrong.channel.send(notification, wrong.use), {
    outcome: "unknown",
    retryable: true,
  });
});

test("both-host channel factory selects the additional adapters without decrypting at construction", async () => {
  const { createPagingChannels } =
    await import("../src/adapters/channels/factory.js");
  for (const provider of providers) {
    let calls = 0;
    const secrets: SecretStore = {
      withSecret: async (_use, consume) => {
        calls++;
        return consume(
          new TextEncoder().encode(JSON.stringify(provider.credentials)),
        );
      },
    };
    const channels = createPagingChannels(secrets, {
      send: async () => ({ status: 200, body: provider.accepted }),
    });
    assert.equal(calls, 0);
    const name = provider.name.toLowerCase() as "ntfy" | "slack" | "discord";
    const channel = channels.forDelivery(name, 120);
    assert.ok(channel);
    const use = fixture(provider, { status: 200, body: provider.accepted }).use;
    assert.deepEqual(await channel.send(notification, use), {
      outcome: "accepted",
      receiptId: null,
    });
    assert.equal(calls, 1);
    assert.equal(channels.forDelivery("email", 120), undefined);
  }
});
