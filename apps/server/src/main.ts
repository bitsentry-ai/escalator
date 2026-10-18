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
    const keys = app.get(SecretKeyRing);
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
