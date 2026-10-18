import { Module } from "@nestjs/common";
import { IncidentLabelManagement } from "@bitsentry-escalator/features/application";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
import { PostgresRuleLabelRepository } from "../../platform/database/rule-labels.repository.js";
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: IncidentLabelManagement,
      inject: [StandaloneDatabase],
      useFactory: (db: StandaloneDatabase) =>
        new IncidentLabelManagement(new PostgresRuleLabelRepository(db.pool)),
    },
  ],
  exports: [IncidentLabelManagement],
})
export class LabelsModule {}
