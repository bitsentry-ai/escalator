import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import {
  HeartbeatManagement,
  HeartbeatHttp,
} from "@bitsentry-escalator/features/application";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { PostgresHeartbeatRepository } from "../../platform/database/heartbeats.repository.js";
import { HeartbeatIngestController } from "./heartbeat.controller.js";
@Module({
  imports: [DatabaseModule],
  controllers: [HeartbeatIngestController],
  providers: [
    {
      provide: HeartbeatManagement,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new HeartbeatManagement(
          new PostgresHeartbeatRepository(db.pool),
          randomUUID,
        ),
    },
    {
      provide: HeartbeatHttp,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new HeartbeatHttp(
          new PostgresHeartbeatRepository(db.pool),
          (scope) => scope === db.workspaceId,
        ),
    },
  ],
  exports: [HeartbeatManagement],
})
export class HeartbeatsModule {}
