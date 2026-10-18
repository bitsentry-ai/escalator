/** Only fixed application messages are mapped. Database/model messages never
 * become user-visible API error text. Hosts translate this descriptor to tRPC. */
export function ruleRequestFailure(error: unknown):
  | {
      code:
        | "BAD_REQUEST"
        | "FORBIDDEN"
        | "CONFLICT"
        | "NOT_FOUND"
        | "PRECONDITION_FAILED";
      message: string;
    }
  | undefined {
  const e = error as { name?: string; code?: string; message?: string } | null;
  if (e?.name === "ZodError")
    return { code: "BAD_REQUEST", message: "Invalid rule request" };
  if (e?.code === "not_found")
    return { code: "NOT_FOUND", message: "Rule record not found" };
  if (e?.code === "scope_violation")
    return { code: "FORBIDDEN", message: "Rule request forbidden" };
  if (e?.code === "already_exists")
    return {
      code: "CONFLICT",
      message: "Rule record already exists; refresh before continuing",
    };
  if (
    [
      "Rule draft forbidden",
      "Rule approval forbidden",
      "Rule read forbidden",
      "Rule results read forbidden",
      "Rule proposal forbidden",
      "Rule replay forbidden",
    ].includes(e?.message ?? "")
  )
    return { code: "FORBIDDEN", message: "Rule request forbidden" };
  if (
    [
      "Rule changed concurrently",
      "Rule changed after review",
      "Rule review expired",
      "Rule evidence changed after review",
      "Proposal changed concurrently",
      "Proposal capture changed",
      "Retire the current rule before changing its definition",
    ].includes(e?.message ?? "")
  )
    return {
      code: "CONFLICT",
      message: "Rule or evidence changed; refresh and review again",
    };
  if (
    [
      "Current paging policy is unavailable",
      "Rule is no longer eligible for activation",
      "Proposal evaluation is not complete",
      "Proposal origin must be reviewed before capture",
      "Proposal requires an intact original retained capture",
      "A different source requires a new rule draft",
    ].includes(e?.message ?? "") ||
    e?.message?.startsWith("Rule requires usable historical evidence: ")
  )
    return {
      code: "PRECONDITION_FAILED",
      message:
        "Rule prerequisites are not met; check source coverage, reviewed evidence and paging policy",
    };
  return undefined;
}
