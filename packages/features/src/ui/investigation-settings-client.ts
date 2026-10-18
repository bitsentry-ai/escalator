import type {
  CreateModelSecretInput,
  CreateInvestigationSettingsInput,
  UpdateInvestigationSettingsInput,
  InvestigationSettings,
  InvestigationSourceOptionsInput,
  InvestigationSourceOptions,
} from "../contracts/index.js";
import type { IncidentsClient } from "./incidents-client.js";
/** Authenticated host transport; model secrets remain opaque references in settings. */
export interface InvestigationSettingsClient extends Pick<
  IncidentsClient,
  "services" | "environments"
> {
  get(
    input: Pick<
      CreateInvestigationSettingsInput,
      "serviceId" | "environmentId"
    >,
  ): Promise<InvestigationSettings | undefined>;
  create(
    input: CreateInvestigationSettingsInput,
  ): Promise<InvestigationSettings>;
  update(
    input: UpdateInvestigationSettingsInput,
  ): Promise<InvestigationSettings>;
  sources(
    input: InvestigationSourceOptionsInput,
  ): Promise<InvestigationSourceOptions>;
  /** Present only where the host permits model credential creation. */
  createSecret?(
    input: CreateModelSecretInput,
  ): Promise<{ id: string; name: string }>;
}
