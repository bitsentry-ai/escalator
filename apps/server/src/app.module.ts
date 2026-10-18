import "reflect-metadata";
import { Module } from "@nestjs/common";
import { SecretKeysModule } from "./platform/secrets/secrets.module.js";
import { AuthModule } from "./platform/auth/auth.module.js";
/** Mounted keys are required before the host can accept requests. */
@Module({ imports: [SecretKeysModule, AuthModule] })
export class AppModule {}
