import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { InvestigationSettingsUseCases } from "@bitsentry-escalator/features/application";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { PostgresInvestigationSourceCatalog } from "../../platform/database/investigation-source-catalog.repository.js";
import { PostgresInvestigationSettingsRepository } from "../../platform/database/investigation-settings.repository.js";
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: PostgresInvestigationSourceCatalog,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new PostgresInvestigationSourceCatalog(
          db.pool,
          db.repositoryConnections,
        ),
    },
    {
      provide: InvestigationSettingsUseCases,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new InvestigationSettingsUseCases(
          new PostgresInvestigationSettingsRepository(
            db.pool,
            db.repositoryConnections,
          ),
          randomUUID,
        ),
    },
  ],
  exports: [InvestigationSettingsUseCases, PostgresInvestigationSourceCatalog],
})
export class InvestigationSettingsModule {}
