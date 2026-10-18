import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import {
  DeploymentManagement,
  DeploymentAccess,
  DeploymentCommands,
  DeploymentHttp,
} from "@bitsentry-escalator/features/application";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { PostgresDeploymentRepository } from "../../platform/database/deployments.repository.js";
import { DeploymentController } from "./deploy.controller.js";
@Module({
  imports: [DatabaseModule],
  controllers: [DeploymentController],
  providers: [
    {
      provide: PostgresDeploymentRepository,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new PostgresDeploymentRepository(db.pool),
    },
    {
      provide: DeploymentManagement,
      inject: [PostgresDeploymentRepository],
      useFactory: (repo: PostgresDeploymentRepository) =>
        new DeploymentManagement(repo, randomUUID),
    },
    {
      provide: DeploymentHttp,
      inject: [PostgresDeploymentRepository, StandaloneDatabase],
      useFactory: (
        repo: PostgresDeploymentRepository,
        db: StandaloneDatabase,
      ) =>
        new DeploymentHttp(
          new DeploymentCommands(
            new DeploymentAccess(repo, (scope) => scope === db.workspaceId),
            randomUUID,
          ),
        ),
    },
  ],
  exports: [DeploymentManagement],
})
export class DeploymentsModule {}
