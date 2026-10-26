import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  escalationPolicySchema,
  pagePolicySchema,
  deploymentPagePolicySchema,
  pagingContactSchema,
  workspaceIdSchema,
  environmentIdSchema,
  responderIdSchema,
  type PagingContact,
  type Responder,
} from "../src/contracts/index.js";
import { startDeployment } from "../src/domain/deploy/lifecycle.js";
import {
  escalationSteps,
  planEscalation,
} from "../src/domain/escalation/ladder.js";
import { stuckDeploymentPolicy } from "../src/application/deploy/stuck-policy.js";
import { PageCreation } from "../src/application/paging/create-page.js";
import { PageAdvancement } from "../src/application/paging/advance.js";
import { MemoryPagingRepository } from "./conformance/memory-paging.js";
import { seedPagingFixture } from "./conformance/paging.js";
import type { DispatchRepository } from "../src/application/paging/routing.js";

async function fixture(
  mapped: string | null = "primary",
  terminalRecipient = "peer",
) {
  let now = new Date("2026-10-04T00:00:00.000Z");
  const scope = workspaceIdSchema.parse("stuck-routing");
  const repository = new MemoryPagingRepository({ now: () => now });
  await repository.transaction(scope, seedPagingFixture);
  const configured = await repository.transaction(scope, async (tx) =>
    escalationPolicySchema.parse((await tx.pages.get("page"))!.policy),
  );
  configured.terminal.notifyResponderIds = [
    responderIdSchema.parse(terminalRecipient),
  ];
  const transition = startDeployment(
    undefined,
    {
      version: 1,
      source: "ci",
      externalId: "run-1",
      environmentId: environmentIdSchema.parse("prod"),
      actor: "display-only",
      commit: "abc",
      artifact: null,
      occurredAt: now.toISOString(),
    },
    {
      id: "deploy",
      workspaceId: scope,
      serviceId: configured.serviceId,
      environmentId: environmentIdSchema.parse("prod"),
      tokenId: "grant",
      mappedDeployerId:
        mapped === null ? null : responderIdSchema.parse(mapped),
      timeoutSeconds: 60,
    },
    now.toISOString(),
  );
  if (transition.state !== "changed") throw new Error("Fixture did not start");
  const entry = {
    targetId: "target",
    deployment: transition.deployment,
    policy: configured,
  };
  const policy = stuckDeploymentPolicy(entry);
  let contacts: PagingContact[] = ["primary", "peer"].map((id) =>
    pagingContactSchema.parse({
      id: `contact-${id}`,
      workspaceId: scope,
      responderId: id,
      channel: "webhook",
      secretId: `secret-${id}`,
      enabled: true,
      priority: 0,
    }),
  );
  let responderOverride: Partial<Responder> | undefined;
  const dispatch: DispatchRepository = {
    transaction: (workspace, run) =>
      repository.transaction(workspace, (tx) =>
        run({
          ...tx,
          responders: {
            ...tx.responders,
            get: async (id) => {
              const value = await tx.responders.get(id);
              return value && id === "primary" && responderOverride
                ? { ...value, ...responderOverride }
                : value;
            },
          },
          routing: {
            schedule: async () => {
              throw new Error("Timeout page must not resolve a schedule");
            },
            contacts: async (id) =>
              contacts.filter((contact) => contact.responderId === id),
          },
        }),
      ),
  };
  const input = {
    incident: {
      id: "stuck-incident",
      serviceId: entry.deployment.serviceId,
      environmentId: entry.deployment.environmentId,
      title: "Deployment exceeded its deadline",
      severity: "high" as const,
    },
    policy,
  };
  const creation = new PageCreation(repository);
  const advance = new PageAdvancement(dispatch);
  const claim = async () => {
    const value = await repository.foundation.claim({
      workspaceId: scope,
      queue: "job",
      kinds: ["paging.step"],
      token: randomUUID(),
      leaseMs: 10000,
    });
    assert.ok(value);
    return value;
  };
  const recipients = async (pageId: string) =>
    repository.transaction(scope, async (tx) =>
      (await tx.deliveries.forPage(pageId, { limit: 100 })).items.map(
        (value) => value.recipientId,
      ),
    );
  return {
    scope,
    repository,
    entry,
    policy,
    input,
    creation,
    advance,
    claim,
    recipients,
    time: (seconds: number) => {
      now = new Date(Date.parse("2026-10-04T00:00:00.000Z") + seconds * 1000);
    },
    contacts: (values: PagingContact[]) => {
      contacts = values;
    },
    contactValues: () => contacts,
    responder: (value: Partial<Responder>) => {
      responderOverride = value;
    },
  };
}
test("timeout routing is a separate, immutable policy with explicit deployer and bounded fallback", async () => {
  const f = await fixture();
  assert.equal(f.policy.deployment.sourcePolicyId, f.entry.policy.id);
  assert.equal(f.policy.deployment.sourcePolicyVersion, f.entry.policy.version);
  assert.notEqual(f.policy.id, f.entry.policy.id);
  assert.equal(escalationPolicySchema.safeParse(f.policy).success, false);
  assert.equal(pagePolicySchema.safeParse(f.entry.policy).success, true);
  const snapshot = structuredClone(f.policy);
  f.entry.policy.fallbackResponderIds.length = 0;
  assert.deepEqual(f.policy, snapshot);
  assert.deepEqual(
    escalationSteps(f.policy, "2026-10-04T00:00:00.000Z").map((step) => [
      step.target,
      step.dueAt,
    ]),
    [
      ["deployer", "2026-10-04T00:00:00.000Z"],
      ["fallback", "2026-10-04T00:02:00.000Z"],
      ["fallback", "2026-10-04T00:03:00.000Z"],
      ["operator", "2026-10-04T00:04:00.000Z"],
    ],
  );
  assert.equal(
    deploymentPagePolicySchema.safeParse({
      ...f.policy,
      steps: [
        { id: "deployer", offsetMs: 0, target: "primary" },
        f.policy.steps[1],
      ],
    }).success,
    false,
  );
});
test("mapped deployer receives first durable intent, then independent service fallback", async () => {
  const f = await fixture();
  const page = await f.creation.open(f.scope, f.input);
  const first = await f.claim();
  await f.advance.advance(first);
  assert.deepEqual(await f.recipients(page.id), ["primary"]);
  await f.advance.advance(first);
  assert.deepEqual(await f.recipients(page.id), ["primary"]);
  await f.repository.foundation.settle(first, { state: "completed" });
  f.time(119);
  assert.equal(
    await f.repository.foundation.claim({
      workspaceId: f.scope,
      queue: "job",
      kinds: ["paging.step"],
      token: randomUUID(),
      leaseMs: 10000,
    }),
    undefined,
  );
  f.time(120);
  await f.advance.advance(await f.claim());
  assert.deepEqual((await f.recipients(page.id)).sort(), ["peer", "primary"]);
});
for (const mode of [
  "unmapped",
  "disabled",
  "viewer",
  "no-contact",
  "disabled-contact",
] as const) {
  test(`${mode} deployer uses the service fallback immediately`, async () => {
    const f = await fixture(mode === "unmapped" ? null : "primary");
    if (mode === "disabled") f.responder({ enabled: false });
    else if (mode === "viewer") f.responder({ role: "viewer" });
    else if (mode === "no-contact")
      f.contacts(
        f
          .contactValues()
          .filter((contact) => contact.responderId !== "primary"),
      );
    else if (mode === "disabled-contact")
      f.contacts(
        f
          .contactValues()
          .map((contact) =>
            contact.responderId === "primary"
              ? { ...contact, enabled: false }
              : contact,
          ),
      );
    const page = await f.creation.open(f.scope, f.input);
    await f.advance.advance(await f.claim());
    assert.deepEqual(await f.recipients(page.id), ["peer"]);
  });
}
test("foreign contact fails atomically instead of silently falling back", async () => {
  const f = await fixture();
  f.contacts(
    f
      .contactValues()
      .map((contact) =>
        contact.responderId === "primary"
          ? { ...contact, workspaceId: workspaceIdSchema.parse("other") }
          : contact,
      ),
  );
  const page = await f.creation.open(f.scope, f.input);
  await assert.rejects(
    f.advance.advance(await f.claim()),
    /Invalid contact scope/,
  );
  assert.deepEqual(await f.recipients(page.id), []);
});
test("restarting after the first deadline skips stale deployer intents and keeps operator bounds", async () => {
  const f = await fixture();
  const page = await f.creation.open(f.scope, f.input);
  f.time(125);
  await f.advance.advance(await f.claim());
  assert.deepEqual(await f.recipients(page.id), ["peer"]);
  const decision = planEscalation({
    policy: f.policy,
    createdAt: page.createdAt,
    now: "2026-10-04T00:10:00.000Z",
    state: "open",
    recordedStepIds: [],
  });
  assert.equal(decision.kind, "dispatch");
  if (decision.kind === "dispatch")
    assert.equal(decision.step.target, "operator");
  assert.equal(
    planEscalation({
      policy: f.policy,
      createdAt: page.createdAt,
      now: "2026-10-04T00:00:00.000Z",
      state: "acknowledged",
      recordedStepIds: [],
    }).kind,
    "cancel",
  );
});

test("terminal operator notifications retain recipients without acknowledgement permission", async () => {
  const f = await fixture("primary", "primary");
  const page = await f.creation.open(f.scope, f.input);
  f.responder({ role: "viewer" });
  f.time(240);
  await f.advance.advance(await f.claim());
  assert.deepEqual(await f.recipients(page.id), ["primary"]);
});
