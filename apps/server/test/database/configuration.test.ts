import test from "node:test";
import assert from "node:assert/strict";
import { testDatabaseConfigured, scopedTestUrl } from "./postgres-fixture.js";

test("application database configuration never enables conformance tests", () => {
  assert.equal(testDatabaseConfigured({}), false);
  assert.equal(
    testDatabaseConfigured({ DATABASE_URL: "not-a-test-connection" }),
    false,
  );
});
test("PostgreSQL conformance requires both explicit role configurations", () => {
  assert.throws(
    () => testDatabaseConfigured({ ESCALATOR_TEST_DATABASE_URL: "app" }),
    /both/,
  );
  assert.throws(
    () =>
      testDatabaseConfigured({
        ESCALATOR_TEST_MIGRATION_DATABASE_URL: "migration",
      }),
    /both/,
  );
  assert.equal(
    testDatabaseConfigured({
      ESCALATOR_TEST_DATABASE_URL: "app",
      ESCALATOR_TEST_MIGRATION_DATABASE_URL: "migration",
    }),
    true,
  );
});

test("connection URL options cannot redirect fixture writes outside its generated schema", () => {
  const schema = `escalator_test_${"a".repeat(32)}`;
  const scoped = new URL(
    scopedTestUrl(
      "postgresql://localhost/disposable?options=-c%20search_path%3Dpublic",
      schema,
    ),
  );
  assert.equal(scoped.searchParams.get("options"), `-c search_path=${schema}`);
  assert.throws(
    () => scopedTestUrl("postgresql://localhost/disposable", "public"),
    /Invalid test schema/,
  );
});
