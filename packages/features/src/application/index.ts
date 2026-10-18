import {
  escalatorContractVersion,
  type EscalatorPackageInfo,
} from "../contracts/index.js";
export function getEscalatorPackageInfo(): EscalatorPackageInfo {
  return { contractVersion: escalatorContractVersion };
}
