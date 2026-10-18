import { MetricsModule } from "../metrics/metrics.module.js";
import { MetricDeployment } from "@bitsentry-escalator/features/application";
import { ProbesModule } from "../probes/probes.module.js";
import { ProbeDeployment } from "@bitsentry-escalator/features/application";
import { randomUUID } from "node:crypto";
import {
  ConfigurationUseCases,
  IncidentUseCases,
} from "@bitsentry-escalator/features/application";
import { PostgresConfigurationRepository } from "../../platform/database/configuration.repository.js";
import {
  AcknowledgementHttp,
  PageAcknowledgements,
} from "@bitsentry-escalator/features/application";
import { PostgresPagingRepository } from "../../platform/database/paging.repository.js";
import { EscalatorAcknowledgementController } from "../../platform/http/ack/ack.controller.js";
import { Logger, Module } from "@nestjs/common";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { SecretKeysModule } from "../../platform/secrets/secrets.module.js";
import { SecretKeyRing } from "../../platform/secrets/keyring.js";
import { PostgresJobsRuntime } from "../../platform/jobs/postgres-jobs.runtime.js";
import { standalonePagingRuntime } from "./runtime.js";
@Module({
  imports: [DatabaseModule, SecretKeysModule, ProbesModule, MetricsModule],
  controllers: [EscalatorAcknowledgementController],
  exports: [IncidentUseCases, ConfigurationUseCases],
  providers: [
    {
      provide: ConfigurationUseCases,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new ConfigurationUseCases(
          new PostgresConfigurationRepository(db.pool),
          randomUUID,
        ),
    },
    {
      provide: IncidentUseCases,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new IncidentUseCases(
          new PostgresConfigurationRepository(db.pool),
          randomUUID,
        ),
    },
    {
      provide: AcknowledgementHttp,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new AcknowledgementHttp(
          new PageAcknowledgements(new PostgresPagingRepository(db.pool)),
          (scope) => scope === db.workspaceId,
        ),
    },
    {
      provide: PostgresJobsRuntime,
      inject: [
        StandaloneDatabase,
        SecretKeyRing,
        ProbeDeployment,
        MetricDeployment,
      ],
      useFactory: (
        db: StandaloneDatabase,
        keys: SecretKeyRing,
        deployment: ProbeDeployment,
        metrics: MetricDeployment,
      ) => {
        const logger = new Logger("EscalatorPaging");
        return standalonePagingRuntime(
          db.pool,
          db.workspaceId,
          keys,
          process.env.ESCALATOR_PUBLIC_URL ?? "",
          (queue) => logger.error(`Paging poll failed: ${queue}`),
          deployment,
          metrics,
        ).runtime;
      },
    },
  ],
})
export class PagingModule {}
