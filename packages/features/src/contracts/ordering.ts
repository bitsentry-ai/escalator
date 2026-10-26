/** Orders strings by UTF-16 code units, exactly like `<` and `>`; unlike `localeCompare` it ignores the locale. */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
export function compareBigInts(left: bigint, right: bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
