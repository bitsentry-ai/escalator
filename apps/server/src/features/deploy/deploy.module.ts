import { DeploymentWatchController } from "./watch.controller.js";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import {
  DeploymentManagement,
  DeploymentQueries,
  DeploymentWatchReader,
  DeploymentWatchHttp,
  type DeploymentWatchTransaction,
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
import { PostgresDeploymentWatchRuntimeRepository } from "../../platform/database/deployment-watch-runtime.repository.js";
import { DeploymentController } from "./deploy.controller.js";
@Module({
  imports: [DatabaseModule],
  controllers: [DeploymentController, DeploymentWatchController],
  providers: [
    {
      provide: DeploymentWatchHttp,
      inject: [PostgresDeploymentWatchRuntimeRepository, StandaloneDatabase],
      useFactory: (
        repo: PostgresDeploymentWatchRuntimeRepository,
        db: StandaloneDatabase,
      ) =>
        new DeploymentWatchHttp(
          new DeploymentWatchReader(
            new DeploymentAccess<DeploymentWatchTransaction>(
              repo,
              (scope) => scope === db.workspaceId,
            ),
          ),
        ),
    },
    {
      provide: PostgresDeploymentWatchRuntimeRepository,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new PostgresDeploymentWatchRuntimeRepository(
          db.pool,
          db.repositoryConnections,
        ),
    },
    {
      provide: DeploymentQueries,
      inject: [PostgresDeploymentWatchRuntimeRepository],
      useFactory: (repo: PostgresDeploymentWatchRuntimeRepository) =>
        new DeploymentQueries(repo),
    },
    {
      provide: DeploymentManagement,
      inject: [PostgresDeploymentWatchRuntimeRepository],
      useFactory: (repo: PostgresDeploymentWatchRuntimeRepository) =>
        new DeploymentManagement(repo, randomUUID),
    },
    {
      provide: DeploymentPreflight,
      inject: [PostgresDeploymentWatchRuntimeRepository, StandaloneDatabase],
      useFactory: (
        repo: PostgresDeploymentWatchRuntimeRepository,
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
        PostgresDeploymentWatchRuntimeRepository,
        StandaloneDatabase,
        DeploymentPreflight,
      ],
      useFactory: (
        repo: PostgresDeploymentWatchRuntimeRepository,
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
  exports: [DeploymentManagement, DeploymentPreflight, DeploymentQueries],
})
export class DeploymentsModule {}
