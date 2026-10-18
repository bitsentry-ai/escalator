import type {
  OperationalIncident,
  OperationalPage,
  IncidentDetail,
  IncidentDelivery,
  IncidentAttempt,
  IncidentPageInput,
  IncidentDeliveriesInput,
  DeliveryAttemptsInput,
  ManualIncidentInput,
  CreateEnvironmentInput,
  Service,
  Environment,
  ConfiguredPolicy,
} from "../contracts/index.js";
export interface IncidentCollection<T> {
  items: T[];
  next: string | null;
}
/** Both hosts implement this using their authenticated tRPC transport. */
export interface IncidentsClient {
  list(
    input: IncidentPageInput,
  ): Promise<IncidentCollection<OperationalIncident>>;
  detail(input: { id: string }): Promise<IncidentDetail>;
  create(
    input: ManualIncidentInput,
  ): Promise<{ incidentId: string; pageId: string }>;
  resolve(input: { id: string }): Promise<OperationalPage>;
  deliveries(
    input: IncidentDeliveriesInput,
  ): Promise<IncidentCollection<IncidentDelivery>>;
  attempts(
    input: DeliveryAttemptsInput,
  ): Promise<IncidentCollection<IncidentAttempt>>;
  services(input: IncidentPageInput): Promise<IncidentCollection<Service>>;
  environments(
    input: IncidentPageInput,
  ): Promise<IncidentCollection<Environment>>;
  policies(
    input: IncidentPageInput,
  ): Promise<IncidentCollection<ConfiguredPolicy>>;
  createEnvironment(input: CreateEnvironmentInput): Promise<Environment>;
}
