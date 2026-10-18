/** For schema-validated UTC ISO timestamps. Date.parse keeps only milliseconds;
 * retain the remaining decimal digits when ordering receipts or availability. */
function milliseconds(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !value.endsWith("Z"))
    throw new RangeError("Expected a valid UTC timestamp");
  return parsed;
}
const remainder = (value: string) =>
  /\.(\d+)Z$/.exec(value)?.[1]?.slice(3) ?? "";
export function hasSubmillisecondTime(value: string): boolean {
  return /[1-9]/.test(remainder(value));
}
export function compareUtcTimestamps(left: string, right: string): number {
  const difference = milliseconds(left) - milliseconds(right);
  if (difference !== 0) return difference < 0 ? -1 : 1;
  const a = remainder(left),
    b = remainder(right),
    size = Math.max(a.length, b.length);
  const paddedA = a.padEnd(size, "0"),
    paddedB = b.padEnd(size, "0");
  return paddedA < paddedB ? -1 : paddedA > paddedB ? 1 : 0;
}
/** Preserve right-closed membership when boundaries use integer milliseconds.
 * This is a comparison key only: never replace the retained evidence timestamp. */
export function ceilTimestampMilliseconds(value: string): number {
  return milliseconds(value) + (hasSubmillisecondTime(value) ? 1 : 0);
}
