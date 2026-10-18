import type {
  ChannelSecretOptions,
  ConfigurationPageInput,
  CreateMonitoringSecretInput,
} from "../contracts/index.js";
/** Hosts authorize scope. Browsers receive metadata, never stored credential values. */
export interface MonitoringSecretsClient {
  secretOptions(input: ConfigurationPageInput): Promise<ChannelSecretOptions>;
  createMonitoringSecret?(
    input: CreateMonitoringSecretInput,
  ): Promise<{ id: string; name: string }>;
}
