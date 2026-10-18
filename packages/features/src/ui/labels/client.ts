import type {
  IncidentLabel,
  IncidentLabelInput,
  IncidentLabelsQuery,
  EditIncidentLabelInput,
  ReviewIncidentLabelInput,
  InvestigationSourceOptionsInput,
  InvestigationSourceOptions,
} from "../../contracts/index.js";
import type { IncidentsClient } from "../incidents-client.js";
export interface LabelsClient extends Pick<
  IncidentsClient,
  "services" | "environments"
> {
  list(
    input: IncidentLabelsQuery,
  ): Promise<{ items: IncidentLabel[]; next: string | null }>;
  get(input: { id: string }): Promise<IncidentLabel | undefined>;
  create(input: IncidentLabelInput): Promise<IncidentLabel>;
  edit(input: EditIncidentLabelInput): Promise<IncidentLabel>;
  review(input: ReviewIncidentLabelInput): Promise<IncidentLabel>;
  /** Existing metadata catalog; UI maps signal labels to the alert source kind. */
  sources(
    input: InvestigationSourceOptionsInput,
  ): Promise<InvestigationSourceOptions>;
}
