/** Package compatibility marker; operational contracts arrive in Phase 1. */
export const escalatorContractVersion = 0 as const;
export interface EscalatorPackageInfo {
  contractVersion: typeof escalatorContractVersion;
}
