import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEscalatorCompatibility,
  assertEscalatorWorkerContract,
} from "../src/contracts/compatibility.js";
const adapter = {
  contractVersion: 1,
  minimumSchemaVersion: 1,
  maximumSchemaVersion: 1,
};
const row = {
  schemaVersion: 1,
  minimumContractVersion: 1,
  maximumContractVersion: 1,
};
test("declared package, adapter and database ranges must overlap", () => {
  assert.doesNotThrow(() => assertEscalatorCompatibility(row, adapter));
  for (const raw of [
    undefined,
    null,
    {},
    { ...row, schemaVersion: 2 },
    { ...row, minimumContractVersion: 2 },
    { ...row, maximumContractVersion: 0 },
    { ...row, schemaVersion: "1" },
  ])
    assert.throws(() => assertEscalatorCompatibility(raw, adapter));
  assert.throws(() =>
    assertEscalatorCompatibility(row, { ...adapter, contractVersion: 2 }),
  );
  assert.throws(() =>
    assertEscalatorCompatibility(row, { ...adapter, minimumSchemaVersion: 2 }),
  );
});
test("worker protocol accepts only declared current or explicit initial legacy contract", () => {
  assert.doesNotThrow(() => assertEscalatorWorkerContract("1"));
  assert.doesNotThrow(() => assertEscalatorWorkerContract(undefined));
  for (const header of [null, "", "01", "1, 2", "2", ["1"], 1])
    assert.throws(() => assertEscalatorWorkerContract(header));
});
