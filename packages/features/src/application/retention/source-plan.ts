import type { ReplayRetentionSettings } from "../../contracts/index.js";
import { planReplayPrune, type ReplayPruneBatch } from "./prune.js";
/** Candidate protection is a lower bound for this batch, never a global usage report.
 * No whole-history aggregate is needed to choose deletions under a source lock.
 * planReplayPrune uses protectedBytes only to validate accounting consistency;
 * its selection depends on exact candidate flags and the committed total.
 */
export function planSourceReplayPrune(
  settings: ReplayRetentionSettings,
  databaseNow: string,
  retainedBytes: number,
  batch: ReplayPruneBatch,
) {
  const candidateProtectedBytes = batch.candidates.reduce(
    (total, row) => total + (row.protected ? row.bytes : 0),
    0,
  );
  return planReplayPrune(
    settings,
    databaseNow,
    { retainedBytes, protectedBytes: candidateProtectedBytes },
    batch,
  );
}
