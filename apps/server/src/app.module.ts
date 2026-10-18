import { RetentionModule } from "./features/retention/retention.module.js";
import { HeartbeatsModule } from "./features/heartbeats/heartbeats.module.js";
import { MetricsModule } from "./features/metrics/metrics.module.js";
import { ProbesModule } from "./features/probes/probes.module.js";
import { SignalsModule } from "./features/signals/signals.module.js";
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { SecretKeysModule } from "./platform/secrets/secrets.module.js";
import { AuthModule } from "./platform/auth/auth.module.js";
import { PagingModule } from "./features/paging/paging.module.js";
import { ServicesModule } from "./features/services/services.module.js";
/** Mounted keys are required before the host can accept requests. */
@Module({
  imports: [
    SecretKeysModule,
    AuthModule,
    ServicesModule,
    PagingModule,
    SignalsModule,
    ProbesModule,
    MetricsModule,
    RetentionModule,
    HeartbeatsModule,
  ],
})
export class AppModule {}
