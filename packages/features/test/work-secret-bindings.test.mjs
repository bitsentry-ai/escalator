import test from "node:test";
import assert from "node:assert/strict";
import { approvedSecretIdsForWork } from "../dist/esm/application/index.js";
test("persisted paging bindings select exactly the delivery credential", () => {
  const payload = { secretId: "provider", approvedSecretIds: ["provider"] };
  for (const [queue, kind] of [
    ["outbox", "paging.send"],
    ["job", "paging.receipt"],
    ["job", "paging.cancel"],
  ])
    assert.deepEqual(approvedSecretIdsForWork(queue, kind, payload), [
      "provider",
    ]);
  for (const payload of [
    null,
    [],
    { secretIds: ["provider"] },
    { secretId: "other", approvedSecretIds: ["provider"] },
    { secretId: "provider", approvedSecretIds: ["provider", "other"] },
    {
      secretId: "provider",
      approvedSecretIds: ["provider"],
      secretIds: ["other"],
    },
  ])
    assert.deepEqual(
      approvedSecretIdsForWork("outbox", "paging.send", payload),
      [],
    );
  assert.deepEqual(approvedSecretIdsForWork("job", "paging.send", payload), []);
  assert.deepEqual(
    approvedSecretIdsForWork("outbox", "paging.receipt", payload),
    [],
  );
  assert.deepEqual(approvedSecretIdsForWork("job", "paging.step", payload), []);
  assert.deepEqual(
    approvedSecretIdsForWork("job", "paging.unknown", payload),
    [],
  );
});
test("non-paging work retains its existing explicit secretIds convention", () => {
  assert.deepEqual(
    approvedSecretIdsForWork("job", "fixture", { secretIds: ["old"] }),
    ["old"],
  );
  assert.equal(
    approvedSecretIdsForWork("job", "fixture", {
      approvedSecretIds: ["not-a-grant"],
    }),
    undefined,
  );
});
