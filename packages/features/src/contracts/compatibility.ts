import { z } from "zod";
/** Increment for incompatible package contracts, independently of migration count. */
export const ESCALATOR_CONTRACT_VERSION = 1;
export const ESCALATOR_SCHEMA_VERSION = 1;
export const ESCALATOR_CONTRACT_HEADER = "x-escalator-contract-version";
const version = z.number().int().min(1).max(2147483647);
export const schemaCompatibilitySchema = z
  .strictObject({
    schemaVersion: version,
    minimumContractVersion: version,
    maximumContractVersion: version,
  })
  .refine((row) => row.minimumContractVersion <= row.maximumContractVersion);
export type SchemaCompatibility = z.infer<typeof schemaCompatibilitySchema>;
export interface AdapterCompatibility {
  readonly contractVersion: number;
  readonly minimumSchemaVersion: number;
  readonly maximumSchemaVersion: number;
}
export class EscalatorCompatibilityError extends Error {
  constructor() {
    super("Escalator schema or contract is incompatible");
  }
}
/** Hosts declare their own adapter range; package and adapter must agree. */
export function assertEscalatorCompatibility(
  raw: unknown,
  adapter: AdapterCompatibility,
): void {
  const parsed = schemaCompatibilitySchema.safeParse(raw);
  if (
    !parsed.success ||
    adapter.contractVersion !== ESCALATOR_CONTRACT_VERSION ||
    !Number.isSafeInteger(adapter.minimumSchemaVersion) ||
    adapter.minimumSchemaVersion < 1 ||
    !Number.isSafeInteger(adapter.maximumSchemaVersion) ||
    adapter.maximumSchemaVersion < adapter.minimumSchemaVersion
  )
    throw new EscalatorCompatibilityError();
  const row = parsed.data;
  if (
    row.schemaVersion !== ESCALATOR_SCHEMA_VERSION ||
    row.schemaVersion < adapter.minimumSchemaVersion ||
    row.schemaVersion > adapter.maximumSchemaVersion ||
    adapter.contractVersion < row.minimumContractVersion ||
    adapter.contractVersion > row.maximumContractVersion
  )
    throw new EscalatorCompatibilityError();
}
/** The pre-header protocol is explicitly contract 1, never an arbitrary fallback. */
export function assertEscalatorWorkerContract(header: unknown): void {
  const legacy = header === undefined;
  if (
    (legacy && ESCALATOR_CONTRACT_VERSION !== 1) ||
    (!legacy && header !== String(ESCALATOR_CONTRACT_VERSION))
  )
    throw new EscalatorCompatibilityError();
}
