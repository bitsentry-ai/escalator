import type { EscalatorPackageInfo } from "../contracts/index.js";
/** Host transport seam. No host router types, authentication, or persistence. */
export interface EscalatorClient {
  getPackageInfo(): Promise<EscalatorPackageInfo>;
}
