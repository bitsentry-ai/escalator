import "reflect-metadata";
import { Module } from "@nestjs/common";
import { SecretKeysModule } from "./platform/secrets/secrets.module.js";
/** Mounted keys are required before the host can accept requests. */
@Module({ imports: [SecretKeysModule] })
export class AppModule {}
