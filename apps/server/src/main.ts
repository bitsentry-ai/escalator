import { signalBodyParser } from "./platform/http/ingest/body-parser.js";
import { PostgresSecretWriter } from "./platform/secrets/postgres-secret.writer.js";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import session from "express-session";
import type { Express } from "express";
import { AppModule } from "./app.module.js";
import { appRouter } from "./platform/trpc/router.js";
import { LocalAuthService } from "./platform/auth/auth.service.js";
import { StandaloneDatabase } from "./platform/database/database.module.js";
import { SecretKeyRing } from "./platform/secrets/keyring.js";
import { PostgresSessionStore } from "./platform/auth/session-store.js";
import {
  cookieOriginGuard,
  sessionOptions,
} from "./platform/auth/session-security.js";
import {
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
  DeploymentPreflight,
  DEPLOYMENT_MAX_BYTES,
  HEARTBEAT_MAX_BYTES,
} from "@bitsentry-escalator/features/application";
/** Construction only: importing this module never starts a listener. */
export async function createApp() {
  const publicUrl = new URL(process.env.ESCALATOR_PUBLIC_URL ?? "");
  if (
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  )
    throw new Error("ESCALATOR_PUBLIC_URL must contain only the public origin");
  const proxyHops = Number(process.env.ESCALATOR_TRUST_PROXY_HOPS ?? "0");
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 4)
    throw new Error("Invalid trusted proxy hop count");
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  try {
    const db = app.get(StandaloneDatabase);
    const auth = app.get(LocalAuthService);
    const services = app.get(ServiceUseCases);
    const signals = app.get(SignalManagement);
    const detection = app.get(DetectionManagement);
    const probes = app.get(ProbeManagement);
    const metrics = app.get(MetricManagement);
    const retention = app.get(RetentionManagement);
    const heartbeats = app.get(HeartbeatManagement);
    const deployments = app.get(DeploymentManagement);
    const deploymentPreflight = app.get(DeploymentPreflight);
    app.use("/v1/deploys", signalBodyParser(DEPLOYMENT_MAX_BYTES));
    app.use("/v1/heartbeats", signalBodyParser(HEARTBEAT_MAX_BYTES));
    app.use("/v1/ingest", signalBodyParser());
    const incidents = app.get(IncidentUseCases);
    const configuration = app.get(ConfigurationUseCases);
    const keys = app.get(SecretKeyRing);
    const secretWriter = new PostgresSecretWriter(db.pool, keys);
    (app.getHttpAdapter().getInstance() as Express).set(
      "trust proxy",
      proxyHops,
    );
    app.use(
      "/trpc",
      session(
        sessionOptions(
          publicUrl,
          keys.sessionSigningKeys(db.workspaceId),
          new PostgresSessionStore(db.pool, db.workspaceId),
        ),
      ),
    );
    app.use("/trpc", cookieOriginGuard(publicUrl.origin));
    app.use(
      "/trpc",
      createExpressMiddleware({
        router: appRouter,
        maxBodySize: 65536,
        createContext: ({ req, res }) => ({
          req,
          res,
          auth,
          services,
          signals,
          detection,
          probes,
          metrics,
          retention,
          heartbeats,
          deployments,
          deploymentPreflight,
          incidents,
          configuration,
          secretWriter,
          workspaceId: db.workspaceId,
        }),
      }),
    );
    app.enableShutdownHooks();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
