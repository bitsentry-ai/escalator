import type { PoolClient } from "pg";
import {
  assertEscalatorCompatibility,
  type AdapterCompatibility,
} from "@bitsentry-escalator/features/contracts";
/** Host-owned declaration, reviewed whenever an adapter/schema contract changes. */
export const standaloneAdapterCompatibility: AdapterCompatibility =
  Object.freeze({
    contractVersion: 1,
    minimumSchemaVersion: 1,
    maximumSchemaVersion: 1,
  });
export async function checkPostgresCompatibility(
  db: Pick<PoolClient, "query">,
  lock = false,
): Promise<void> {
  const result = await db.query(
    `SELECT schema_version AS "schemaVersion", minimum_contract_version AS "minimumContractVersion", maximum_contract_version AS "maximumContractVersion" FROM escalator_compatibility WHERE id=1${lock ? " FOR SHARE" : ""}`,
  );
  assertEscalatorCompatibility(
    result.rows.length === 1 ? result.rows[0] : undefined,
    standaloneAdapterCompatibility,
  );
}
