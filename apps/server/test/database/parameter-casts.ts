/** node-postgres binds untyped parameters and PostgreSQL fixes each one's type at
 * its first cast; a later `$n::text` of a `$n::timestamptz` then renders DateStyle
 * text, not the bound ISO string. Lists parameters cast to more than one type. */
export function mixedParameterCasts(sql: string): string[] {
  const casts = new Map<string, Set<string>>();
  for (const [, id, cast] of sql.matchAll(/\$(\d+)(::\w+)?/g)) {
    if (cast) casts.set(id!, (casts.get(id!) ?? new Set()).add(cast));
  }
  return [...casts]
    .filter(([, types]) => types.size > 1)
    .map(([id, types]) => `$${id} ${[...types].sort().join("|")}`);
}
