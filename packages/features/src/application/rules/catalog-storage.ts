import { z } from "zod";
import {
  workspaceIdSchema,
  type WorkspaceId,
} from "../../contracts/identity.js";
import {
  ruleCatalogEntrySchema,
  ruleReviewReceiptSchema,
  ruleActivationHistorySchema,
} from "../../contracts/rule-catalog.js";
import { PersistenceError } from "../ports/persistence.js";
const schemas = {
  catalog: ruleCatalogEntrySchema,
  review: ruleReviewReceiptSchema,
  history: ruleActivationHistorySchema,
};
type Kind = keyof typeof schemas;
type Row<K extends Kind> = z.infer<(typeof schemas)[K]>;
export function encodeRuleCatalogData<K extends Kind>(
  scope: WorkspaceId,
  kind: K,
  input: Row<K>,
): string {
  workspaceIdSchema.parse(scope);
  const row = schemas[kind].parse(input);
  if (row.workspaceId !== scope) throw new PersistenceError("scope_violation");
  const encoded = JSON.stringify(row, (key, value: unknown) =>
    key === "workspaceId" ? undefined : value,
  );
  if (Buffer.byteLength(encoded) > (kind === "catalog" ? 32768 : 16384))
    throw new Error("Rule record exceeds storage bound");
  return encoded;
}
export function decodeRuleCatalogData<K extends Kind>(
  scope: WorkspaceId,
  kind: K,
  input: unknown,
): Row<K> {
  workspaceIdSchema.parse(scope);
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.prototype.hasOwnProperty.call(input, "workspaceId")
  )
    throw new PersistenceError("scope_violation");
  if (
    Buffer.byteLength(JSON.stringify(input)) >
    (kind === "catalog" ? 32768 : 16384)
  )
    throw new Error("Rule record exceeds storage bound");
  return schemas[kind].parse({ ...input, workspaceId: scope }) as Row<K>;
}
