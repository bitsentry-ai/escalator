import type {
  CreateServiceInput,
  ListServicesInput,
  ServicePage,
  Service,
} from "../contracts/index.js";
/** Typed feature transport; hosts supply their authenticated tRPC adapters. */
export interface ServicesClient {
  listServices(input: ListServicesInput): Promise<ServicePage>;
  createService(input: CreateServiceInput): Promise<Service>;
  getService(id: string): Promise<Service>;
}
