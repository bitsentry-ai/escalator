import { randomUUID } from "node:crypto";
import { Logger, Module } from "@nestjs/common";
import { ServiceUseCases } from "@bitsentry-escalator/features/application";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { PostgresFoundationRepository } from "../../platform/database/foundation.repository.js";
import { PostgresJobsRuntime } from "../../platform/jobs/postgres-jobs.runtime.js";
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: ServiceUseCases,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new ServiceUseCases(
          new PostgresFoundationRepository(db.pool),
          randomUUID,
        ),
    },
    {
      provide: PostgresJobsRuntime,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new PostgresJobsRuntime(
          db.pool,
          db.workspaceId,
          { job: new Map(), outbox: new Map() },
          (queue) =>
            new Logger("EscalatorJobs").error(`Work poll failed: ${queue}`),
        ),
    },
  ],
  exports: [ServiceUseCases],
})
export class ServicesModule {}
