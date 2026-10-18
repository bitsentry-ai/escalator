import type { PostgresSecretWriter } from "../secrets/postgres-secret.writer.js";
import { initTRPC } from "@trpc/server";
import type { Request, Response } from "express";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import type { LocalAuthService } from "../auth/auth.service.js";
import type {
  ConfigurationUseCases,
  IncidentUseCases,
  ServiceUseCases,
  SignalManagement,
  DetectionManagement,
  ProbeManagement,
  MetricManagement,
  RetentionManagement,
  HeartbeatManagement,
  DeploymentManagement,
  DeploymentQueries,
  DeploymentPreflight,
} from "@bitsentry-escalator/features/application";
export interface AppContext {
  secretWriter: PostgresSecretWriter;
  services: ServiceUseCases;
  signals: SignalManagement;
  detection: DetectionManagement;
  probes: ProbeManagement;
  metrics: MetricManagement;
  retention: RetentionManagement;
  heartbeats: HeartbeatManagement;
  deployments: DeploymentManagement;
  deploymentQueries: DeploymentQueries;
  deploymentPreflight: DeploymentPreflight;
  incidents: IncidentUseCases;
  configuration: ConfigurationUseCases;
  req: Request;
  res: Response;
  auth: LocalAuthService;
  workspaceId: WorkspaceId;
}
export const t = initTRPC.context<AppContext>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    message:
      error.code === "INTERNAL_SERVER_ERROR" ? "Request failed" : shape.message,
    data: { ...shape.data, stack: undefined },
  }),
});
