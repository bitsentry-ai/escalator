import test from "node:test";
import assert from "node:assert/strict";
import { repositoryConnectionsFromJSON } from "../../src/platform/database/repository-connections.js";
import {
  workspaceIdSchema,
  serviceIdSchema,
  environmentIdSchema,
} from "@bitsentry-escalator/features/contracts";
const scope = {
  workspaceId: workspaceIdSchema.parse("org_a"),
  serviceId: serviceIdSchema.parse("api"),
  environmentId: environmentIdSchema.parse("prod"),
};
const connection = {
  scope,
  sourceId: "repository",
  targetId: "target",
  name: "API",
  owner: "bitsentry-ai",
  repository: "api",
  secretId: null,
  enabled: true,
};
test("repository connections are absent by default and only explicit metadata is exposed", () => {
  assert.equal(
    repositoryConnectionsFromJSON(undefined).get(scope, "repository"),
    undefined,
  );
  const catalog = repositoryConnectionsFromJSON(JSON.stringify([connection]));
  assert.deepEqual(catalog.get(scope, "repository"), connection);
  assert.equal(
    catalog.get(
      { ...scope, environmentId: environmentIdSchema.parse("staging") },
      "repository",
    ),
    undefined,
  );
});
test("invalid and oversized repository configuration fails without echoing input", () => {
  for (const raw of [
    "private-value",
    JSON.stringify({ token: "private-value" }),
    JSON.stringify([{ ...connection, token: "private-value" }]),
    " ".repeat(262145),
  ]) {
    assert.throws(
      () => repositoryConnectionsFromJSON(raw),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Invalid ESCALATOR_REPOSITORIES configuration",
        );
        assert.doesNotMatch(error.message, /private-value/);
        return true;
      },
    );
  }
});
test("an operator cannot silently replace an existing workspace source with a duplicate connection", () => {
  assert.throws(() =>
    repositoryConnectionsFromJSON(
      JSON.stringify([connection, { ...connection, repository: "other" }]),
    ),
  );
});
