/**
 * Returns a value an earlier step guarantees, such as a map entry written for every key, and throws when that
 * guarantee is broken instead of letting `undefined` travel further.
 */
export function expectDefined<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${what}`);
  return value;
}
