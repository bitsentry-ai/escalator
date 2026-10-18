import { InvestigationReports } from "@bitsentry-escalator/features/application";
import { PostgresInvestigationReportRepository } from "../../../platform/database/postgres-investigation-report.repository.js";
import { Logger, Module } from "@nestjs/common";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../../platform/database/database.module.js";
import { SecretKeysModule } from "../../../platform/secrets/secrets.module.js";
import { SecretKeyRing } from "../../../platform/secrets/keyring.js";
import { StandaloneInvestigationDeployment } from "./deployment.js";
import { StandaloneInvestigationRuntime } from "./runtime.js";
@Module({
  imports: [DatabaseModule, SecretKeysModule],
  exports: [InvestigationReports],
  providers: [
    {
      provide: InvestigationReports,
      inject: [StandaloneDatabase, StandaloneInvestigationDeployment],
      useFactory: (
        db: StandaloneDatabase,
        deployment: StandaloneInvestigationDeployment,
      ) =>
        new InvestigationReports(
          new PostgresInvestigationReportRepository(db.pool),
          () => (deployment.enabled ? "configured" : "disabled"),
        ),
    },
    {
      provide: StandaloneInvestigationDeployment,
      useFactory: () =>
        StandaloneInvestigationDeployment.fromJSON(
          process.env.ESCALATOR_INVESTIGATION,
        ),
    },
    {
      provide: StandaloneInvestigationRuntime,
      inject: [
        StandaloneDatabase,
        SecretKeyRing,
        StandaloneInvestigationDeployment,
      ],
      useFactory: (
        db: StandaloneDatabase,
        keys: SecretKeyRing,
        deployment: StandaloneInvestigationDeployment,
      ) =>
        new StandaloneInvestigationRuntime(
          process.env.ESCALATOR_DATABASE_URL ?? "",
          db.workspaceId,
          keys,
          deployment,
          () =>
            new Logger("EscalatorInvestigation").warn(
              "Investigation operation unavailable",
            ),
          db.repositoryConnections,
        ),
    },
  ],
})
export class StandaloneInvestigationModule {}
