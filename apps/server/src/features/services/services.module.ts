import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { ServiceUseCases } from "@bitsentry-escalator/features/application";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { PostgresFoundationRepository } from "../../platform/database/foundation.repository.js";
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: ServiceUseCases,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new ServiceUseCases(
          new PostgresFoundationRepository(db.pool),
          randomUUID,
        ),
    },
  ],
  exports: [ServiceUseCases],
})
export class ServicesModule {}
