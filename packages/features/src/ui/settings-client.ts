import type {
  ConfigurationPageInput,
  ConfiguredContact,
  ConfiguredPolicy,
  Availability,
  WriteContactInput,
  WritePolicyInput,
  WriteAvailabilityInput,
  StoredPreviewQuery,
  SchedulePreview,
  ChannelSecretOptions,
  CreateChannelSecretInput,
} from "../contracts/index.js";
import type { OnCallClient, OnCallPage } from "./oncall-client.js";
/** Hosts supply authenticated scope; values are write-only and never persisted by the UI. */
export interface PagingSettingsClient extends OnCallClient {
  storedPreview(input: { id: string }): Promise<SchedulePreview>;
  contacts(
    input: ConfigurationPageInput,
  ): Promise<OnCallPage<ConfiguredContact>>;
  writeContact(input: WriteContactInput): Promise<ConfiguredContact>;
  policies(
    input: ConfigurationPageInput,
  ): Promise<OnCallPage<ConfiguredPolicy>>;
  policy(input: { id: string }): Promise<ConfiguredPolicy>;
  writePolicy(input: WritePolicyInput): Promise<ConfiguredPolicy>;
  availability(
    input: ConfigurationPageInput,
  ): Promise<OnCallPage<Availability>>;
  writeAvailability(input: WriteAvailabilityInput): Promise<Availability>;
  previews(input: StoredPreviewQuery): Promise<OnCallPage<SchedulePreview>>;
  secretOptions(input: ConfigurationPageInput): Promise<ChannelSecretOptions>;
  createSecret?(
    input: CreateChannelSecretInput,
  ): Promise<{ id: string; name: string }>;
}

export type ContactSettingsClient = Pick<
  PagingSettingsClient,
  "contacts" | "responders" | "writeContact" | "secretOptions" | "createSecret"
>;
