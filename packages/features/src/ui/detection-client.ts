import type {
  DetectionBindingKey,
  WriteDetectionBindingInput,
  ServiceEnvironment,
  ConfiguredPolicy,
  ConfigurationPageInput,
} from "../contracts/index.js";
export interface DetectionClient {
  binding(input: DetectionBindingKey): Promise<ServiceEnvironment | undefined>;
  configureBinding(
    input: WriteDetectionBindingInput,
  ): Promise<ServiceEnvironment>;
  policies(
    input: ConfigurationPageInput,
  ): Promise<{ items: ConfiguredPolicy[]; next: string | null }>;
}
