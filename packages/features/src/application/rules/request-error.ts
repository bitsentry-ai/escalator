export type RuleRequestErrorCode =
  | "FORBIDDEN"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "METRIC_PAGING_CONFLICT";
export class RuleRequestError extends Error {
  constructor(
    readonly code: RuleRequestErrorCode,
    message?: string,
  ) {
    super(
      message ??
        (code === "METRIC_PAGING_CONFLICT"
          ? "This metric selector already has a paging metric monitor; use shadow mode to avoid double paging"
          : code),
    );
    this.name = "RuleRequestError";
  }
}
/** Hosts expose fixed descriptions only; infrastructure messages stay private. */
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
  const e = error as { name?: string; code?: string } | null;
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
  if (!(error instanceof RuleRequestError)) return undefined;
  switch (error.code) {
    case "FORBIDDEN":
      return { code: "FORBIDDEN", message: "Rule request forbidden" };
    case "CONFLICT":
      return {
        code: "CONFLICT",
        message: "Rule or evidence changed; refresh and review again",
      };
    case "METRIC_PAGING_CONFLICT":
      return {
        code: "PRECONDITION_FAILED",
        message:
          "This metric selector already has a paging metric monitor; use shadow mode to avoid double paging",
      };
    case "PRECONDITION_FAILED":
      return {
        code: "PRECONDITION_FAILED",
        message:
          "Rule prerequisites are not met; check source coverage, reviewed evidence and paging policy",
      };
  }
}
