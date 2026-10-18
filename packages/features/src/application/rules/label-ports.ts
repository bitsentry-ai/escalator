import type {
  Actor,
  WorkspaceId,
  ServiceId,
  EnvironmentId,
} from "../../contracts/identity.js";
import type {
  IncidentLabel,
  IncidentLabelInput,
} from "../../contracts/rule-label.js";
import type { OperationalIncident } from "../../contracts/paging.js";
import type {
  FoundationTransaction,
  Page,
  PageRequest,
} from "../ports/persistence.js";

export interface LabelSelection {
  serviceId: ServiceId;
  environmentId: EnvironmentId;
  stream?: IncidentLabelInput["stream"];
  status?: IncidentLabel["status"];
}
export interface LabelStream {
  workspaceId: WorkspaceId;
  serviceId: ServiceId;
  environmentId: EnvironmentId;
  kind: IncidentLabelInput["stream"]["kind"];
  id: string;
}
/** All primitives use the surrounding physical transaction and tenant filter.
 * lockStream takes a shared row lock before any label lock. References may be
 * disabled: labeling historical evidence does not enable monitoring.
 */
export interface IncidentLabelRecordStore {
  currentTime(): Promise<string>;
  lockStream(
    stream: IncidentLabelInput["stream"],
  ): Promise<LabelStream | undefined>;
  incident(id: string): Promise<OperationalIncident | undefined>;
  get(id: string, lock: boolean): Promise<IncidentLabel | undefined>;
  list(
    selection: LabelSelection,
    page: PageRequest,
  ): Promise<Page<IncidentLabel>>;
  /** Insert at null, otherwise CAS an existing draft. Reviewed records cannot
   * be overwritten or deleted. A false CAS changes nothing.
   */
  put(value: IncidentLabel, expectedRevision: number | null): Promise<boolean>;
}
export interface IncidentLabelTransaction extends FoundationTransaction {
  labels: {
    get(actor: Actor, id: string): Promise<IncidentLabel | undefined>;
    list(
      actor: Actor,
      selection: LabelSelection,
      page: PageRequest,
    ): Promise<Page<IncidentLabel>>;
    create(actor: Actor, input: IncidentLabelInput): Promise<IncidentLabel>;
    edit(
      actor: Actor,
      id: string,
      expectedRevision: number,
      input: IncidentLabelInput,
    ): Promise<IncidentLabel>;
    review(
      actor: Actor,
      id: string,
      expectedRevision: number,
    ): Promise<IncidentLabel>;
  };
}
export interface IncidentLabelRepository {
  /** Await every operation; failures poison the transaction, including caught
   * errors. State changes and human audit append commit or roll back together.
   */
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: IncidentLabelTransaction) => Promise<T>,
  ): Promise<T>;
}
