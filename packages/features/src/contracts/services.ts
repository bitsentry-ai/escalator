import { z } from "zod";
import { serviceSchema, type Service } from "./entities.js";
export const createServiceSchema = z.strictObject({
  name: serviceSchema.shape.name,
  key: serviceSchema.shape.key,
  owningTeam: serviceSchema.shape.owningTeam,
});
export const listServicesSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(25),
  after: z.string().min(1).max(200).optional(),
});
export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type ListServicesInput = z.input<typeof listServicesSchema>;
export interface ServicePage {
  items: Service[];
  next: string | null;
}
