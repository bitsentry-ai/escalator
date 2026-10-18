import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import {
  ProbeDeployment,
  ProbeManagement,
} from "@bitsentry-escalator/features/application";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { PostgresProbeRepository } from "../../platform/database/probes.repository.js";
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: ProbeDeployment,
      useFactory: () => ProbeDeployment.fromJSON(process.env.ESCALATOR_PROBES),
    },
    {
      provide: ProbeManagement,
      inject: [StandaloneDatabase, ProbeDeployment],
      useFactory: (db: StandaloneDatabase, deployment: ProbeDeployment) =>
        new ProbeManagement(
          new PostgresProbeRepository(db.pool),
          randomUUID,
          deployment.policy,
          deployment.limits,
        ),
    },
  ],
  exports: [ProbeDeployment, ProbeManagement],
})
export class ProbesModule {}
