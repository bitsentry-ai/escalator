import test from "node:test";
import assert from "node:assert/strict";
import { MemoryConfigurationRepository } from "./conformance/memory-configuration.js";
import { seedPagingFixture } from "./conformance/paging.js";
import {
  availabilitySchema,
  configuredContactSchema,
  pagingContactSchema,
  workspaceIdSchema,
  workingHoursSchema,
} from "../src/contracts/index.js";
test("configured contacts stay scoped and availability does not suppress duty", async () => {
  const repo = new MemoryConfigurationRepository();
  const scope = workspaceIdSchema.parse("config-positive");
  await repo.transaction(scope, seedPagingFixture);
  await repo.transaction(scope, async (tx) => {
    const contact = configuredContactSchema.parse({
      id: "contact",
      workspaceId: scope,
      responderId: "primary",
      version: 1,
      secretId: "fixture-secret",
      channel: "webhook",
      enabled: true,
      priority: 0,
    });
    await tx.configuration.contacts.put(contact, null);
    const availability = availabilitySchema.parse({
      id: "primary",
      workspaceId: scope,
      version: 1,
      timeZone: "Asia/Ho_Chi_Minh",
      windows: [],
    });
    await tx.configuration.availability.put(availability, null);
    const routed = await tx.routing.contacts(contact.responderId);
    assert.deepEqual(routed, [pagingContactSchema.strip().parse(contact)]);
    // Dispatch uses the strict DTO parser, so storage version metadata must be absent.
    assert.deepEqual(pagingContactSchema.parse(routed[0]), routed[0]);
    assert.equal(
      (await tx.configuration.availability.get(availability.id))!.windows
        .length,
      0,
    );
    assert.equal(
      workingHoursSchema.parse({
        responderId: availability.id,
        timeZone: availability.timeZone,
        windows: availability.windows,
      }).windows.length,
      0,
    );
  });
  await repo.transaction(
    workspaceIdSchema.parse("other-config"),
    async (tx) => {
      assert.deepEqual(
        await tx.routing.contacts(
          "primary" as Parameters<typeof tx.routing.contacts>[0],
        ),
        [],
      );
    },
  );
});

test("contact saves reject a wrong-channel credential and cap new contacts at 100", async () => {
  const repo = new MemoryConfigurationRepository();
  const scope = workspaceIdSchema.parse("contact-limits");
  await repo.transaction(scope, seedPagingFixture);
  const contact = configuredContactSchema.parse({
    id: "contact",
    workspaceId: scope,
    responderId: "primary",
    version: 1,
    secretId: "fixture-secret",
    channel: "webhook",
    enabled: true,
    priority: 0,
  });
  await assert.rejects(
    repo.transaction(scope, (tx) =>
      tx.configuration.contacts.put({ ...contact, channel: "pushover" }, null),
    ),
    /not_found/,
  );
  await repo.transaction(scope, async (tx) => {
    for (let i = 0; i < 100; i++)
      assert.equal(
        await tx.configuration.contacts.put(
          { ...contact, id: `contact-${i}` },
          null,
        ),
        true,
      );
  });
  await assert.rejects(
    repo.transaction(scope, (tx) =>
      tx.configuration.contacts.put(contact, null),
    ),
    /too_many_contacts/,
  );
  await repo.transaction(scope, async (tx) => {
    assert.equal(
      await tx.configuration.contacts.put(
        { ...contact, id: "contact-0", version: 2, enabled: false },
        1,
      ),
      true,
    );
    assert.equal(
      (await tx.configuration.contacts.list({ limit: 100 })).items.length,
      100,
    );
  });
});
