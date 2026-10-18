import { randomUUID } from "node:crypto";
import {
  RuleManagement,
  RuleCatalogQueries,
  RuleDrafts,
  ReviewRuleActivation,
  CaptureRuleReplay,
  RuleProposalGeneration,
  RuleResultsQueries,
} from "@bitsentry-escalator/features/application";
import { PostgresRuleCatalogRepository } from "../../platform/database/rule-catalog.repository.js";
import { PostgresRuleCatalogReadRepository } from "../../platform/database/rule-catalog-read.repository.js";
import { PostgresRuleReplayRepository } from "../../platform/database/rule-replay.repository.js";
import { PostgresRuleProposalRepository } from "../../platform/database/rule-proposal.repository.js";
import { PostgresRuleResultsRepository } from "../../platform/database/rule-results.repository.js";
import { Module } from "@nestjs/common";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../../platform/database/database.module.js";
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: RuleManagement,
      inject: [StandaloneDatabase],
      useFactory: (database: StandaloneDatabase) => {
        const db = database.pool;
        const catalog = new PostgresRuleCatalogRepository(db);
        return new RuleManagement(
          new RuleCatalogQueries(new PostgresRuleCatalogReadRepository(db)),
          new RuleDrafts(catalog, randomUUID),
          new ReviewRuleActivation(catalog, randomUUID),
          new CaptureRuleReplay(
            new PostgresRuleReplayRepository(db),
            randomUUID,
          ),
          new RuleProposalGeneration(new PostgresRuleProposalRepository(db)),
          new RuleResultsQueries(new PostgresRuleResultsRepository(db)),
        );
      },
    },
  ],
  exports: [RuleManagement],
})
export class RulesModule {}
