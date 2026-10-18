import type {
  InvestigationSettings,
  InvestigationSourceSelection,
} from "../../contracts/investigation-settings.js";
import type {
  Actor,
  WorkspaceId,
  ServiceId,
  EnvironmentId,
} from "../../contracts/identity.js";
import type { FoundationTransaction } from "../ports/persistence.js";
export interface InvestigationSettingsScope {
  workspaceId: WorkspaceId;
  serviceId: ServiceId;
  environmentId: EnvironmentId;
}
/** SQL is host-owned. Every operation uses the enclosing scoped transaction.
 * Lock service/environment before settings, sources and secret metadata in a fixed order.
 * No provider, WorkOS or Vault network calls while the transaction is held.
 */
export interface InvestigationSettingsStore {
  /** Lock the scope, including the absent-settings case, to serialize creation. */
  lockScope(scope: InvestigationSettingsScope): Promise<boolean>;
  get(id: string): Promise<InvestigationSettings | undefined>;
  selected(
    scope: InvestigationSettingsScope,
  ): Promise<InvestigationSettings | undefined>;
  /** Lock and verify ownership, current generation and actor access; ambiguous legacy ownership denies. */
  authorizeSources(
    actor: Actor,
    scope: InvestigationSettingsScope,
    sources: readonly InvestigationSourceSelection[],
  ): Promise<boolean>;
  /** Metadata authorization only; must bind this model purpose and destination, never return secret bytes. */
  authorizeSecret(
    actor: Actor,
    profile: InvestigationSettings["profile"],
  ): Promise<boolean>;
  /** CAS plus unique service/environment selection. Source link rows commit atomically with the profile. */
  put(
    value: InvestigationSettings,
    expectedRevision: number | null,
  ): Promise<boolean>;
}
export interface InvestigationSettingsTransaction extends FoundationTransaction {
  investigationSettings: {
    get(id: string): Promise<InvestigationSettings | undefined>;
    selected(
      scope: InvestigationSettingsScope,
    ): Promise<InvestigationSettings | undefined>;
    save(
      actor: Actor,
      value: InvestigationSettings,
      expectedRevision: number | null,
    ): Promise<boolean>;
  };
}
export interface InvestigationSettingsRepository {
  transaction<T>(
    workspaceId: WorkspaceId,
    run: (tx: InvestigationSettingsTransaction) => Promise<T>,
  ): Promise<T>;
}
