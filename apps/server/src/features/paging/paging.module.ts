import {
  AcknowledgementHttp,
  PageAcknowledgements,
} from "@bitsentry-escalator/features/application";
import { PostgresPagingRepository } from "../../platform/database/paging.repository.js";
import { EscalatorAcknowledgementController } from "../../platform/http/ack/ack.controller.js";
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
  controllers: [EscalatorAcknowledgementController],
  providers: [
    {
      provide: AcknowledgementHttp,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new AcknowledgementHttp(
          new PageAcknowledgements(new PostgresPagingRepository(db.pool)),
          (scope) => scope === db.workspaceId,
        ),
    },
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
