import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import {
  DeploymentManagement,
  DeploymentPreflight,
  type CoverageTransaction,
  DeploymentAccess,
  DeploymentCommands,
  DeploymentHttp,
} from "@bitsentry-escalator/features/application";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { PostgresDeploymentRuntimeRepository } from "../../platform/database/deployment-runtime.repository.js";
import { DeploymentController } from "./deploy.controller.js";
@Module({
  imports: [DatabaseModule],
  controllers: [DeploymentController],
  providers: [
    {
      provide: PostgresDeploymentRuntimeRepository,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new PostgresDeploymentRuntimeRepository(db.pool),
    },
    {
      provide: DeploymentManagement,
      inject: [PostgresDeploymentRuntimeRepository],
      useFactory: (repo: PostgresDeploymentRuntimeRepository) =>
        new DeploymentManagement(repo, randomUUID),
    },
    {
      provide: DeploymentPreflight,
      inject: [PostgresDeploymentRuntimeRepository, StandaloneDatabase],
      useFactory: (
        repo: PostgresDeploymentRuntimeRepository,
        db: StandaloneDatabase,
      ) =>
        new DeploymentPreflight(
          repo,
          randomUUID,
          (scope) => scope === db.workspaceId,
        ),
    },
    {
      provide: DeploymentHttp,
      inject: [
        PostgresDeploymentRuntimeRepository,
        StandaloneDatabase,
        DeploymentPreflight,
      ],
      useFactory: (
        repo: PostgresDeploymentRuntimeRepository,
        db: StandaloneDatabase,
        preflight: DeploymentPreflight,
      ) => {
        const commands = new DeploymentCommands(
          new DeploymentAccess<CoverageTransaction>(
            repo,
            (scope) => scope === db.workspaceId,
          ),
          randomUUID,
          (context, input) => preflight.requireForStart(context, input),
        );
        return new DeploymentHttp({
          start: commands.start.bind(commands),
          finish: commands.finish.bind(commands),
          preflight: preflight.preflight.bind(preflight),
        });
      },
    },
  ],
  exports: [DeploymentManagement, DeploymentPreflight],
})
export class DeploymentsModule {}
