import { z } from "zod";
import {
  ruleProposalSchema,
  type RuleProposal,
} from "../../contracts/rule-proposal.js";
import type { WorkspaceId } from "../../contracts/identity.js";
import { PersistenceError } from "../ports/persistence.js";
const object = z.record(z.string(), z.unknown());
export function encodeRuleProposal(
  scope: WorkspaceId,
  raw: RuleProposal,
): string {
  const row = ruleProposalSchema.parse(raw);
  if (row.workspaceId !== scope) throw new PersistenceError("scope_violation");
  const text = JSON.stringify(row, (key, value: unknown) =>
    key === "workspaceId" ? undefined : value,
  );
  if (Buffer.byteLength(text) > 65536)
    throw new Error("Proposal storage limit exceeded");
  return text;
}
/** Physical tenant key is authoritative. Neither host stores a competing tenant
 * identifier inside its JSON data; candidate scope is restored at this boundary. */
export function decodeRuleProposal(
  scope: WorkspaceId,
  input: unknown,
): RuleProposal {
  const data = object.parse(input);
  let generation: unknown = data.generation;
  if (generation !== null) {
    const result = object.parse(generation),
      candidate = object.parse(result.candidate),
      definition = object.parse(candidate.definition);
    generation = {
      ...result,
      candidate: {
        ...candidate,
        definition: { ...definition, workspaceId: scope },
      },
    };
  }
  return ruleProposalSchema.parse({ ...data, workspaceId: scope, generation });
}
/** Bind only authoritative database expiry, never request-body lease timestamps.
 * Start the measurement before the SQL clock query to conservatively include
 * query/network time. The host also checks DB time before returning its callback. */
export class RuleProposalLeaseFence {
  private expiresAt = Number.POSITIVE_INFINITY;
  constructor(
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}
  start(): number {
    return this.monotonicNow();
  }
  bind(started: number, remainingMs: number): void {
    if (
      !Number.isFinite(started) ||
      !Number.isFinite(remainingMs) ||
      remainingMs <= 0 ||
      remainingMs > 120000
    )
      throw new Error("Invalid proposal lease deadline");
    this.expiresAt = Math.min(this.expiresAt, started + remainingMs);
    this.assertLive();
  }
  assertLive(): void {
    if (this.monotonicNow() >= this.expiresAt)
      throw new Error("Proposal lease expired before commit");
  }
}
