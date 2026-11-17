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
const STORAGE_LIMITS = {
  snapshot: 16777216,
  run: 16384,
  chunk: 262144,
} as const;
function parseReplayRow(kind: "snapshot" | "run" | "chunk", raw: unknown) {
  if (kind === "snapshot") return storedRuleReplaySnapshotSchema.parse(raw);
  if (kind === "run") return ruleReplayRunSchema.parse(raw);
  return ruleReplayChunkSchema.parse(raw);
}
/** Storage removes the package tenant field throughout the strictly parsed
 * scalar projection. Each host restores it from its actual scoped SQL column. */
export function encodeRuleReplayData(
  scope: WorkspaceId,
  kind: "snapshot" | "run" | "chunk",
  raw: unknown,
): string {
  const row = parseReplayRow(kind, raw);
  if (row.workspaceId !== scope) throw new PersistenceError("scope_violation");
  // Scope is validated before compacting. Repeating UUID selectors per sample
  // needlessly consumes the 30-day snapshot budget; decode supports old rows too.
  const compact = (sample: object) =>
    Object.fromEntries(
      Object.entries(sample).filter(
        ([key]) =>
          ![
            "workspaceId",
            "serviceId",
            "environmentId",
            "kind",
            "streamId",
          ].includes(key),
      ),
    );
  const compacted =
    "snapshot" in row
      ? {
          ...row,
          snapshot: {
            ...row.snapshot,
            samples: row.snapshot.samples.map(compact),
            retained: row.snapshot.retained
              ? {
                  ...row.snapshot.retained,
                  history: {
                    ...row.snapshot.retained.history,
                    receipts: row.snapshot.retained.history.receipts.map(
                      (r) => ({ ...r, sample: compact(r.sample) }),
                    ),
                  },
                }
              : undefined,
          },
        }
      : row;
  const encoded = JSON.stringify(compacted, (key, value: unknown) =>
    key === "workspaceId" ? undefined : value,
  );
  if (new TextEncoder().encode(encoded).byteLength > STORAGE_LIMITS[kind])
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
  const definition = snapshot.version.definition;
  const sampleScope = {
    serviceId: definition.serviceId,
    environmentId: definition.environmentId,
    kind: definition.selector.kind,
    streamId: definition.selector.streamId,
  };
  const retained = snapshot.retained
    ? {
        ...snapshot.retained,
        ...(snapshot.retained.baselines
          ? {
              baselines: {
                ...snapshot.retained.baselines,
                groups: snapshot.retained.baselines.groups.map((g) => ({
                  ...g,
                  version: {
                    ...g.version,
                    definition: { ...g.version.definition, workspaceId: scope },
                  },
                })),
              },
            }
          : {}),
        history: {
          ...snapshot.retained.history,
          workspaceId: scope,
          receipts: snapshot.retained.history.receipts.map((r) => ({
            ...r,
            sample: { ...sampleScope, ...r.sample, workspaceId: scope },
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
      ...(retained ? { retained } : {}),
      version: {
        ...snapshot.version,
        definition: { ...snapshot.version.definition, workspaceId: scope },
      },
      samples: snapshot.samples.map((sample) => ({
        ...sampleScope,
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
