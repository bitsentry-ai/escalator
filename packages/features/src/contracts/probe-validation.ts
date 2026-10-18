import type { HttpProbeConfig } from "./probes.js";
/** Own-property lookup only; no JSONPath evaluation, prototype traversal or regular expressions. */
export function probeJsonValue(
  root: unknown,
  path: readonly (string | number)[],
): unknown {
  let value = root;
  for (const key of path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    if (Array.isArray(value) && typeof key !== "number") return undefined;
    if (!Array.isArray(value) && typeof key !== "string") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
/** Bound JSON structure as well as bytes; parsing is native, traversal is iterative. */
export function boundedProbeJson(body: string): unknown {
  const root: unknown = JSON.parse(body);
  const stack: { value: unknown; depth: number }[] = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > 10000 || depth > 16) throw new Error("JSON bounds exceeded");
    if (value !== null && typeof value === "object")
      for (const child of Object.values(value)) {
        if (nodes + stack.length >= 10000)
          throw new Error("JSON bounds exceeded");
        stack.push({ value: child, depth: depth + 1 });
      }
  }
  return root;
}
export function validateSyntheticProbe(config: HttpProbeConfig): void {
  if (config.method !== "POST") return;
  if (!config.syntheticWrite || config.body === null)
    throw new Error("Synthetic write requires setup");
  const body = boundedProbeJson(config.body);
  if (
    !Object.is(
      probeJsonValue(body, config.syntheticWrite.markerPath),
      config.syntheticWrite.markerValue,
    )
  )
    throw new Error("Synthetic body lacks its configured test marker");
}
