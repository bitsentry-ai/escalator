import { Logger, Module } from "@nestjs/common";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { SecretKeysModule } from "../../platform/secrets/secrets.module.js";
import { SecretKeyRing } from "../../platform/secrets/keyring.js";
import { PostgresJobsRuntime } from "../../platform/jobs/postgres-jobs.runtime.js";
import { standalonePagingRuntime } from "./runtime.js";
@Module({
  imports: [DatabaseModule, SecretKeysModule],
  providers: [
    {
      provide: PostgresJobsRuntime,
      inject: [StandaloneDatabase, SecretKeyRing],
      useFactory: (db: StandaloneDatabase, keys: SecretKeyRing) => {
        const logger = new Logger("EscalatorPaging");
        return standalonePagingRuntime(
          db.pool,
          db.workspaceId,
          keys,
          process.env.ESCALATOR_PUBLIC_URL ?? "",
          (queue) => logger.error(`Paging poll failed: ${queue}`),
        ).runtime;
      },
    },
  ],
})
export class PagingModule {}
