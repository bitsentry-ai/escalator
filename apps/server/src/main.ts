import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { AppModule } from "./app.module.js";
import { appRouter } from "./platform/trpc/router.js";
/** Construction only: importing this module never starts a listener. */
export async function createApp() {
  const app = await NestFactory.create(AppModule);
  app.use("/trpc", createExpressMiddleware({ router: appRouter }));
  return app;
}
