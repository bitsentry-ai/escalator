import {
  escalatorContractVersion,
  type EscalatorPackageInfo,
} from "../contracts/index.js";
export function getEscalatorPackageInfo(): EscalatorPackageInfo {
  return { contractVersion: escalatorContractVersion };
}

export * from "./ports/persistence.js";
export * from "./ports/audit.js";
export * from "./ports/transaction-guard.js";

export * from "./jobs/ports.js";
export * from "./jobs/runner.js";
export * from "./jobs/validation.js";

export * from "./jobs/poller.js";
export * from "./jobs/scheduler.js";

export * from "./ports/secrets.js";

export * from "./services/services.use-cases.js";

export * from "../domain/schedule/resolve.js";
export * from "../domain/escalation/ladder.js";
export * from "./paging/persistence.js";
export * from "./paging/validation.js";
export * from "./paging/record-store.js";
export * from "./paging/incident-order.js";
export * from "./paging/transaction.js";
export * from "./paging/work-ids.js";
export * from "./paging/acknowledge.js";

export * from "./paging/create-page.js";
export * from "./paging/routing.js";
export * from "./paging/advance.js";
export * from "./paging/cancel.js";
export * from "./paging/send.js";
export * from "./paging/provider-jobs.js";

export * from "./configuration/ports.js";
export * from "./configuration/transaction.js";

export * from "./paging/handlers.js";

export * from "./paging/ack-http.js";

export * from "./incidents/incidents.use-cases.js";
