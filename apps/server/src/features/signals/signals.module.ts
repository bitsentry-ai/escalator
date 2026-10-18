import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import {
  SignalHttp,
  SignalManagement,
} from "@bitsentry-escalator/features/application";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { PostgresSignalRepository } from "../../platform/database/signals.repository.js";
import { SignalIngestController } from "../../platform/http/ingest/ingest.controller.js";
@Module({
  imports: [DatabaseModule],
  controllers: [SignalIngestController],
  providers: [
    {
      provide: PostgresSignalRepository,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new PostgresSignalRepository(db.pool),
    },
    {
      provide: SignalManagement,
      inject: [PostgresSignalRepository],
      useFactory: (repository: PostgresSignalRepository) =>
        new SignalManagement(repository, randomUUID),
    },
    {
      provide: SignalHttp,
      inject: [PostgresSignalRepository, StandaloneDatabase],
      useFactory: (
        repository: PostgresSignalRepository,
        db: StandaloneDatabase,
      ) => new SignalHttp(repository, (scope) => scope === db.workspaceId),
    },
  ],
  exports: [SignalManagement],
})
export class SignalsModule {}
