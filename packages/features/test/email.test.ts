import test from "node:test";
import assert from "node:assert/strict";
import {
  EmailChannel,
  type EmailTransport,
} from "../src/adapters/channels/email.js";
import { emailCredentialsSchema } from "../src/contracts/email-credentials.js";
import type {
  SecretStore,
  SecretUse,
} from "../src/application/ports/secrets.js";
import { workspaceIdSchema } from "../src/contracts/index.js";
const credentials = {
  host: "smtp.example.com",
  port: 465,
  username: "user",
  password: "private-password",
  from: "ops@example.com",
  to: "oncall@example.com",
};
const notification = {
  deliveryId: "delivery-1",
  title: "Outage",
  message: "API down",
  acknowledgementUrl: "https://ops.example/ack#token=private-token",
};
function fixture(
  result: Awaited<ReturnType<EmailTransport["send"]>> | Error,
  options: { credentials?: unknown; after?: boolean; during?: boolean } = {},
) {
  const controller = new AbortController();
  const use: SecretUse = {
    workspaceId: workspaceIdSchema.parse("org_one"),
    secretId: "secret",
    queue: "outbox",
    workId: "work",
    claimToken: "claim",
    signal: controller.signal,
  };
  const calls: Parameters<EmailTransport["send"]>[] = [];
  let secretsRead = 0;
  const secrets: SecretStore = {
    async withSecret(actual, operation) {
      assert.equal(actual, use);
      secretsRead++;
      const value = await operation(
        Buffer.from(JSON.stringify(options.credentials ?? credentials)),
      );
      if (options.after) throw new Error("private broker failure");
      return value;
    },
  };
  const transport: EmailTransport = {
    async send(...args) {
      calls.push(args);
      if (options.during) controller.abort();
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return {
    secrets,
    transport,
    channel: new EmailChannel(secrets, transport),
    controller,
    use,
    calls,
    reads: () => secretsRead,
  };
}
test("email confirms submission without persisting recipient, body or acknowledgement", async () => {
  const f = fixture("accepted");
  assert.deepEqual(await f.channel.send(notification, f.use), {
    outcome: "accepted",
    receiptId: null,
  });
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.calls[0]![1].text,
    "API down\n\nhttps://ops.example/ack#token=private-token",
  );
  assert.match(f.calls[0]![1].messageId, /^<[a-f0-9]{64}@escalator\.invalid>$/);
  await f.channel.send(notification, f.use);
  assert.equal(f.calls[0]![1].messageId, f.calls[1]![1].messageId);
});
for (const result of ["unknown", new Error("private provider body")] as const)
  test(
    "email uncertain delivery is retryable without leaking provider data: " +
      typeof result,
    async () => {
      const f = fixture(result);
      assert.deepEqual(await f.channel.send(notification, f.use), {
        outcome: "unknown",
        retryable: true,
      });
    },
  );
for (const result of ["rejected", "retry"] as const)
  test("email explicit refusal: " + result, async () => {
    const f = fixture(result);
    assert.deepEqual(await f.channel.send(notification, f.use), {
      outcome: "rejected",
      retryable: result === "retry",
      reason: "provider_rejected",
    });
  });
test("email lease loss before sending never reads a secret", async () => {
  const f = fixture("accepted");
  f.controller.abort();
  assert.deepEqual(await f.channel.send(notification, f.use), {
    outcome: "unknown",
    retryable: true,
  });
  assert.equal(f.reads(), 0);
  assert.equal(f.calls.length, 0);
});
for (const option of [{ during: true }, { after: true }])
  test(
    "email acceptance becomes unknown after claim/secret fence loss " +
      JSON.stringify(option),
    async () => {
      const f = fixture("accepted", option);
      assert.deepEqual(await f.channel.send(notification, f.use), {
        outcome: "unknown",
        retryable: true,
      });
    },
  );
test("email refuses credentials and header injection before transport", async () => {
  for (const change of [
    { port: 25 },
    { host: "127.0.0.1" },
    { to: "a@example.com,b@example.com" },
    { from: "Name <a@example.com>" },
    { password: "pass\r\ninjected" },
  ]) {
    const f = fixture("accepted", {
      credentials: { ...credentials, ...change },
    });
    assert.deepEqual(await f.channel.send(notification, f.use), {
      outcome: "rejected",
      retryable: false,
      reason: "invalid_configuration",
    });
    assert.equal(f.calls.length, 0);
  }
  const f = fixture("accepted");
  assert.equal(
    (
      await f.channel.send(
        { ...notification, title: "Outage\r\nBcc: other@example.com" },
        f.use,
      )
    ).outcome,
    "rejected",
  );
  assert.equal(f.reads(), 0);
  assert.equal(
    emailCredentialsSchema.safeParse({
      ...credentials,
      tls: { rejectUnauthorized: false },
    }).success,
    false,
  );
});
test("email credentials reject escaped secret payloads beyond the decryption bound", () => {
  assert.equal(
    emailCredentialsSchema.safeParse({
      ...credentials,
      password: "\\".repeat(4096),
    }).success,
    false,
  );
});

test("both hosts select the email adapter without using the HTTP delivery transport", async () => {
  const { createPagingChannels } =
    await import("../src/adapters/channels/factory.js");
  const f = fixture("accepted");
  const channels = createPagingChannels(
    f.secrets,
    {
      async send() {
        throw new Error("email must not use HTTP");
      },
    },
    f.transport,
  );
  assert.equal(f.reads(), 0);
  const email = channels.forDelivery("email", 120);
  assert.ok(email);
  assert.deepEqual(await email.send(notification, f.use), {
    outcome: "accepted",
    receiptId: null,
  });
  assert.equal(f.calls.length, 1);
});

test("email secret failures before submission are redacted and never contact SMTP", async () => {
  const f = fixture("accepted");
  const channel = new EmailChannel(
    {
      async withSecret() {
        throw new Error("private credential and broker detail");
      },
    },
    f.transport,
  );
  assert.deepEqual(await channel.send(notification, f.use), {
    outcome: "rejected",
    retryable: true,
    reason: "secret_unavailable",
  });
  assert.equal(f.calls.length, 0);
});

test("email message identifiers distinguish tenants sharing the same delivery id", async () => {
  const one = fixture("accepted"),
    two = fixture("accepted");
  two.use.workspaceId = workspaceIdSchema.parse("org_two");
  await one.channel.send(notification, one.use);
  await two.channel.send(notification, two.use);
  assert.notEqual(one.calls[0]![1].messageId, two.calls[0]![1].messageId);
});

test("email normalizes domains while preserving the case-sensitive local part", () => {
  const parsed = emailCredentialsSchema.parse({
    ...credentials,
    from: "Sender@EXAMPLE.COM",
    to: "OnCall@EXAMPLE.COM",
  });
  assert.equal(parsed.from, "Sender@example.com");
  assert.equal(parsed.to, "OnCall@example.com");
});
