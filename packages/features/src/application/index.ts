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
