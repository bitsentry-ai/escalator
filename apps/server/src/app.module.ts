import "reflect-metadata";
import { Module } from "@nestjs/common";
import { SecretKeysModule } from "./platform/secrets/secrets.module.js";
import { AuthModule } from "./platform/auth/auth.module.js";
import { PagingModule } from "./features/paging/paging.module.js";
import { ServicesModule } from "./features/services/services.module.js";
/** Mounted keys are required before the host can accept requests. */
@Module({
  imports: [SecretKeysModule, AuthModule, ServicesModule, PagingModule],
})
export class AppModule {}
