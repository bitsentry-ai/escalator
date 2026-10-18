import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const c = require("../dist/cjs/contracts/index.js");
const timestamps = {
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};
const fixtures = [
  [c.workspaceSchema, { id: "org_workos_1", name: "Platform", ...timestamps }],
  [
    c.serviceSchema,
    {
      id: "service_1",
      workspaceId: "org_workos_1",
      name: "API",
      key: "api",
      owningTeam: "Platform",
      enabled: true,
      ...timestamps,
    },
  ],
  [
    c.environmentSchema,
    {
      id: "environment_1",
      workspaceId: "org_workos_1",
      name: "Production",
      key: "production",
      isProduction: true,
      ...timestamps,
    },
  ],
  [
    c.responderSchema,
    {
      id: "responder_1",
      workspaceId: "org_workos_1",
      hostUserId: "42",
      displayName: "Alex",
      timeZone: "America/New_York",
      role: "responder",
      enabled: true,
      ...timestamps,
    },
  ],
];
for (const [index, [schema, fixture]] of fixtures.entries()) {
  test(`entity fixture ${index} preserves valid records and rejects stale timestamps and unexpected fields`, () => {
    assert.deepEqual(schema.parse(fixture), fixture);
    assert.equal(
      schema.safeParse({ ...fixture, updatedAt: "2026-09-17T00:00:00Z" })
        .success,
      false,
    );
    assert.equal(
      schema.safeParse({ ...fixture, invented: true }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ ...fixture, createdAt: "2026-09-18T01:00:00+01:00" })
        .success,
      false,
    );
  });
}
test("workspace identifiers support both hosts without accepting empty or path-like scope", () => {
  for (const id of ["org_01ABC", "43727cab-e11d-4246-a7fa-8f68958c8a49"])
    assert.equal(c.workspaceIdSchema.parse(id), id);
  for (const id of ["", "../org", "org/a", "org a", "org\n", "x".repeat(129)])
    assert.equal(c.workspaceIdSchema.safeParse(id).success, false);
});
test("capabilities keep viewer read-only and reserve administration for administrators", () => {
  for (const capability of c.capabilities)
    assert.equal(c.hasCapability("administrator", capability), true);
  assert.equal(c.hasCapability("viewer", "incident:read"), true);
  assert.equal(c.hasCapability("viewer", "incident:acknowledge"), false);
  assert.equal(c.hasCapability("responder", "incident:acknowledge"), true);
  assert.equal(c.hasCapability("responder", "rule:propose"), true);
  for (const capability of [
    "rule:approve",
    "deployment:override",
    "secret:manage",
    "workspace:manage",
  ])
    assert.equal(c.hasCapability("responder", capability), false);
  assert.equal(c.roleSchema.safeParse("owner").success, false);
});
test("timezone and entity validation reject unusable configuration", () => {
  for (const zone of ["UTC", "America/New_York", "Asia/Ho_Chi_Minh"])
    assert.equal(c.timeZoneSchema.safeParse(zone).success, true);
  for (const zone of ["Not/AZone", "", "+01:00"])
    assert.equal(c.timeZoneSchema.safeParse(zone).success, false);
  assert.equal(
    c.serviceSchema.safeParse({ ...fixtures[1][1], owningTeam: " " }).success,
    false,
  );
  assert.equal(
    c.serviceSchema.safeParse({ ...fixtures[1][1], key: "API / production" })
      .success,
    false,
  );
});
