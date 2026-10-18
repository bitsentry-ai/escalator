import type {
  Schedule,
  ConfiguredPolicy,
  Availability,
  SchedulePreview,
  ConfiguredContact,
  WorkspaceId,
} from "../../contracts/index.js";
import type {
  EntityRepository,
  PageRequest,
  Page,
} from "../ports/persistence.js";
import type { DispatchTransaction } from "../paging/routing.js";
export interface ConfigurationRecordMap {
  schedules: Schedule;
  policies: ConfiguredPolicy;
  contacts: ConfiguredContact;
  availability: Availability;
  previews: SchedulePreview;
}
export type ConfigurationKind = keyof ConfigurationRecordMap;
export type MutableConfigurationKind = Exclude<ConfigurationKind, "previews">;
export interface VersionedRepository<
  T extends { id: string; workspaceId: WorkspaceId; version: number },
> extends Omit<EntityRepository<T>, "insert"> {
  /** null creates version one; otherwise compare-and-swap exactly expected + 1. */
  put(value: T, expectedVersion: number | null): Promise<boolean>;
}
export interface ConfigurationTransaction extends DispatchTransaction {
  configuration: {
    schedules: VersionedRepository<Schedule>;
    policies: VersionedRepository<ConfiguredPolicy>;
    contacts: VersionedRepository<ConfiguredContact>;
    availability: VersionedRepository<Availability>;
    previews: EntityRepository<SchedulePreview> & {
      forSchedule(
        id: string,
        query: PageRequest,
      ): Promise<Page<SchedulePreview>>;
    };
  };
}
export interface ConfigurationRepository {
  transaction<T>(
    workspaceId: WorkspaceId,
    run: (tx: ConfigurationTransaction) => Promise<T>,
  ): Promise<T>;
}
/** Host primitives share the physical paging transaction. Never resolve plaintext here. */
export interface ConfigurationRecordStore {
  get<K extends ConfigurationKind>(
    kind: K,
    id: string,
    lock?: boolean,
  ): Promise<ConfigurationRecordMap[K] | undefined>;
  list<K extends ConfigurationKind>(
    kind: K,
    query: PageRequest,
    parentId?: string,
  ): Promise<Page<ConfigurationRecordMap[K]>>;
  insert<K extends ConfigurationKind>(
    kind: K,
    value: ConfigurationRecordMap[K],
  ): Promise<void>;
  replace<K extends MutableConfigurationKind>(
    kind: K,
    value: ConfigurationRecordMap[K],
  ): Promise<void>;
  secretExists(id: string): Promise<boolean>;
}
