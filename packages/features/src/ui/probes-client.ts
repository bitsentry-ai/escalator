import type {
  CreateProbeInput,
  UpdateProbeInput,
  Probe,
  ProbeResult,
  Service,
  Environment,
} from "../contracts/index.js";
export interface ProbeCollection<T> {
  items: T[];
  next: string | null;
}
export interface ProbePageInput {
  after?: string;
  limit?: number;
}
/** Authenticated hosts supply scope. This interface contains no server imports. */
export interface ProbesClient {
  list(input: ProbePageInput): Promise<ProbeCollection<Probe>>;
  create(input: CreateProbeInput): Promise<Probe>;
  update(input: UpdateProbeInput): Promise<Probe>;
  disable(input: { id: string; expectedVersion: number }): Promise<Probe>;
  history(
    input: ProbePageInput & { id: string },
  ): Promise<ProbeCollection<ProbeResult>>;
  services(input: ProbePageInput): Promise<ProbeCollection<Service>>;
  environments(input: ProbePageInput): Promise<ProbeCollection<Environment>>;
}
