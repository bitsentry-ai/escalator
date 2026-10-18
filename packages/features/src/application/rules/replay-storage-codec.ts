import {
  ruleReplayRunSchema,
  ruleReplayChunkSchema,
  storedRuleReplaySnapshotSchema,
  type RuleReplayRun,
  type RuleReplayChunk,
  type StoredRuleReplaySnapshot,
} from "../../contracts/replay-run.js";
import type { WorkspaceId } from "../../contracts/identity.js";
import { PersistenceError } from "../ports/persistence.js";
/** Storage removes the package tenant field throughout the strictly parsed
 * scalar projection. Each host restores it from its actual scoped SQL column. */
export function encodeRuleReplayData(
  scope: WorkspaceId,
  kind: "snapshot" | "run" | "chunk",
  raw: unknown,
): string {
  const row =
    kind === "snapshot"
      ? storedRuleReplaySnapshotSchema.parse(raw)
      : kind === "run"
        ? ruleReplayRunSchema.parse(raw)
        : ruleReplayChunkSchema.parse(raw);
  if (row.workspaceId !== scope) throw new PersistenceError("scope_violation");
  const encoded = JSON.stringify(row, (key, value: unknown) =>
    key === "workspaceId" ? undefined : value,
  );
  const limit =
    kind === "snapshot" ? 16777216 : kind === "run" ? 16384 : 262144;
  if (new TextEncoder().encode(encoded).byteLength > limit)
    throw new RangeError("Replay storage limit exceeded");
  return encoded;
}
/** Intermediate casts only locate fields; strict schemas validate the completed
 * result before any value reaches the application. Malformed storage throws. */
export function decodeRuleReplaySnapshot(
  scope: WorkspaceId,
  raw: unknown,
): StoredRuleReplaySnapshot {
  const row = raw as StoredRuleReplaySnapshot,
    snapshot = row.snapshot;
  const retained = snapshot.retained
    ? {
        ...snapshot.retained,
        history: {
          ...snapshot.retained.history,
          workspaceId: scope,
          receipts: snapshot.retained.history.receipts.map((r) => ({
            ...r,
            sample: { ...r.sample, workspaceId: scope },
          })),
        },
        policyFacts: snapshot.retained.policyFacts.map((f) => ({
          ...f,
          workspaceId: scope,
        })),
      }
    : undefined;
  return storedRuleReplaySnapshotSchema.parse({
    ...row,
    workspaceId: scope,
    snapshot: {
      ...snapshot,
      retained,
      version: {
        ...snapshot.version,
        definition: { ...snapshot.version.definition, workspaceId: scope },
      },
      samples: snapshot.samples.map((sample) => ({
        ...sample,
        workspaceId: scope,
      })),
    },
  });
}
export function decodeRuleReplayRun(
  scope: WorkspaceId,
  raw: unknown,
): RuleReplayRun {
  const row = raw as RuleReplayRun;
  return ruleReplayRunSchema.parse({
    ...row,
    workspaceId: scope,
    cursor:
      row.cursor === null
        ? null
        : {
            ...row.cursor,
            state: { ...row.cursor?.state, workspaceId: scope },
          },
  });
}
export function decodeRuleReplayChunk(
  scope: WorkspaceId,
  raw: unknown,
): RuleReplayChunk {
  const row = raw as RuleReplayChunk;
  return ruleReplayChunkSchema.parse({
    ...row,
    workspaceId: scope,
    decisions: row.decisions.map((d) => ({
      ...d,
      state: { ...d.state, workspaceId: scope },
    })),
  });
}
