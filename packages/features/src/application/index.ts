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

export { resolvePageInTransaction } from "./paging/resolve.js";

export * from "./configuration/configuration.use-cases.js";

export * from "./signals/ports.js";
export * from "./signals/ingest.js";
export * from "./signals/transaction.js";

export * from "./signals/management.js";
export * from "./signals/http.js";

export * from "../adapters/intake/sentry.js";
export * from "../adapters/intake/glitchtip.js";
export * from "../adapters/intake/grafana-alerts.js";

export * from "./signals/source-secrets.js";
export * from "./signals/provider-ingest.js";
export * from "./signals/provider-http.js";

export * from "../domain/alerts/transition.js";
export * from "./detection/ports.js";
export * from "./detection/transaction.js";

export * from "./detection/process.js";
export { SignalRecovery } from "./detection/recovery.js";
export * from "./detection/handlers.js";
export * from "./detection/management.js";
export * from "../domain/probes/observe.js";
export * from "../domain/probes/assertions.js";
export * from "../adapters/probes/policy.js";
export * from "./probes/transport.js";
export * from "./probes/http-runner.js";
export * from "../adapters/probes/http.js";

export * from "./probes/ports.js";
export * from "./probes/schedule.js";
export * from "./probes/transaction.js";
export * from "./probes/execute.js";
export * from "./probes/management.js";
export * from "./probes/capacity.js";
