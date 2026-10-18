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
