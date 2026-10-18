import { PostgresDetectionRepository } from "../../platform/database/detection.repository.js";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import {
  SignalHttp,
  SignalManagement,
  DetectionManagement,
  ProviderIntake,
  ProviderHttp,
} from "@bitsentry-escalator/features/application";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { PostgresSignalRepository } from "../../platform/database/signals.repository.js";
import { SignalIngestController } from "../../platform/http/ingest/ingest.controller.js";
import { SecretKeysModule } from "../../platform/secrets/secrets.module.js";
import { SecretKeyRing } from "../../platform/secrets/keyring.js";
import { PostgresSourceVerificationSecrets } from "../../platform/secrets/source-verification.store.js";
import { ProviderIngestController } from "../../platform/http/ingest/provider.controller.js";
@Module({
  imports: [DatabaseModule, SecretKeysModule],
  controllers: [SignalIngestController, ProviderIngestController],
  providers: [
    {
      provide: DetectionManagement,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new DetectionManagement(
          new PostgresDetectionRepository(db.pool, db.repositoryConnections),
          randomUUID,
        ),
    },
    {
      provide: ProviderHttp,
      inject: [PostgresSignalRepository, StandaloneDatabase, SecretKeyRing],
      useFactory: (
        repository: PostgresSignalRepository,
        db: StandaloneDatabase,
        keys: SecretKeyRing,
      ) =>
        new ProviderHttp(
          new ProviderIntake(
            repository,
            new PostgresSourceVerificationSecrets(db.pool, keys),
            (scope) => scope === db.workspaceId,
            randomUUID,
          ),
        ),
    },
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
  exports: [SignalManagement, DetectionManagement],
})
export class SignalsModule {}
