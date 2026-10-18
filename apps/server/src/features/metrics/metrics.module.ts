import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import {
  MetricDeployment,
  MetricManagement,
} from "@bitsentry-escalator/features/application";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { PostgresMetricsRepository } from "../../platform/database/metrics.repository.js";
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: MetricDeployment,
      useFactory: () =>
        MetricDeployment.fromJSON(process.env.ESCALATOR_METRICS),
    },
    {
      provide: MetricManagement,
      inject: [StandaloneDatabase, MetricDeployment],
      useFactory: (db: StandaloneDatabase, deployment: MetricDeployment) =>
        new MetricManagement(
          new PostgresMetricsRepository(db.pool),
          randomUUID,
          deployment.policy,
          deployment.limits,
        ),
    },
  ],
  exports: [MetricDeployment, MetricManagement],
})
export class MetricsModule {}
