import { randomUUID } from "node:crypto";
import { Logger, Module } from "@nestjs/common";
import {
  RetentionManagement,
  RetentionPolicyManagement,
  ReplayCoverageReader,
} from "@bitsentry-escalator/features/application";
import { PostgresRetentionPolicyRepository } from "../../platform/database/retention-policy.repository.js";
import { PostgresReplayCoverageRepository } from "../../platform/database/coverage.repository.js";
import { StandaloneRetentionResources } from "./resources.js";
@Module({
  providers: [
    {
      provide: StandaloneRetentionResources,
      useFactory: () =>
        new StandaloneRetentionResources(
          process.env.ESCALATOR_DATABASE_URL ?? "",
          () =>
            new Logger("EscalatorRetention").error(
              "Maintenance database unavailable",
            ),
        ),
    },
    {
      provide: RetentionManagement,
      inject: [StandaloneRetentionResources],
      useFactory: (resources: StandaloneRetentionResources) =>
        new RetentionManagement(
          new RetentionPolicyManagement(
            new PostgresRetentionPolicyRepository(resources.pool),
            randomUUID,
          ),
          new ReplayCoverageReader(
            new PostgresReplayCoverageRepository(resources.pool),
          ),
          resources.admission,
        ),
    },
  ],
  exports: [StandaloneRetentionResources, RetentionManagement],
})
export class RetentionModule {}
