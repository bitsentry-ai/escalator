/** Package contract compatibility marker. */
export const escalatorContractVersion = 0 as const;
export interface EscalatorPackageInfo {
  contractVersion: typeof escalatorContractVersion;
}

export * from "./identity.js";
export * from "./entities.js";

export * from "./services.js";

export * from "./schedule.js";
export * from "./escalation.js";
