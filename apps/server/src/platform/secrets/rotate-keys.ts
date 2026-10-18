export interface KeyRotationBatch {
  rotated: number;
  conflicts: number;
  remaining: number;
  next?: string;
}
/** Finite, resumable maintenance. Concurrent edits are reported, never overwritten. */
export async function rotateKeys(
  runBatch: (after?: string) => Promise<KeyRotationBatch>,
) {
  let after: string | undefined;
  let rotated = 0;
  let conflicts = 0;
  for (let batch = 0; batch < 10_000; batch++) {
    const result = await runBatch(after);
    rotated += result.rotated;
    conflicts += result.conflicts;
    if (result.remaining === 0 || !result.next)
      return { rotated, conflicts, remaining: result.remaining };
    if (result.next === after)
      throw new Error("Key rotation cursor did not advance");
    after = result.next;
  }
  throw new Error(
    "Key rotation batch limit reached; resume in another maintenance run",
  );
}
