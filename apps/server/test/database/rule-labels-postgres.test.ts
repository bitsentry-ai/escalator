import type { LabelStream } from "@bitsentry-escalator/features/application";
import type { OperationalIncident } from "@bitsentry-escalator/features/contracts";
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { ruleLabelConformance } from "@escalator-test/rule-labels";
import {
  seedRuleLabelStream,
  seedReviewedRuleLabel,
} from "@escalator-test/rule-label-seed";
import { PostgresRuleLabelRepository } from "../../src/platform/database/rule-labels.repository.js";
import { PostgresFoundationRepository } from "../../src/platform/database/foundation.repository.js";
import { PostgresSignalRepository } from "../../src/platform/database/signals.repository.js";
import { PostgresProbeRepository } from "../../src/platform/database/probes.repository.js";
import { PostgresMetricsRepository } from "../../src/platform/database/metrics.repository.js";
import { PostgresPagingRepository } from "../../src/platform/database/paging.repository.js";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";

async function fixture(labelMutationPrivileges = false) {
  const database = await postgresFixture(
    await readMigrations(resolve("migrations")),
    { labelMutationPrivileges },
  );
  const streams = {
    signals: new PostgresSignalRepository(database.app),
    probes: new PostgresProbeRepository(database.app),
    metrics: new PostgresMetricsRepository(database.app),
  };
  const paging = new PostgresPagingRepository(database.app);
  return {
    database,
    repository: new PostgresRuleLabelRepository(database.app),
    foundation: new PostgresFoundationRepository(database.app),
    seedStream: (stream: LabelStream) => seedRuleLabelStream(streams, stream),
    seedIncident: (incident: OperationalIncident) =>
      paging.transaction(incident.workspaceId, (tx) =>
        tx.incidents.insert(incident),
      ),
    dispose: () => database.dispose(),
  };
}
ruleLabelConformance("standalone PostgreSQL incident labels", () => fixture(), {
  skip: testDatabaseConfigured()
    ? undefined
    : "No disposable PostgreSQL test database configured",
});

test(
  "PostgreSQL rejects direct updates and deletion of reviewed labels",
  { skip: !testDatabaseConfigured() },
  async () => {
    const f = await fixture(true);
    try {
      const { label } = await seedReviewedRuleLabel(f);
      for (const sql of [
        "UPDATE escalator_incident_label SET data=data WHERE workspace_id=$1 AND id=$2",
        "DELETE FROM escalator_incident_label WHERE workspace_id=$1 AND id=$2",
      ]) {
        const connection = await f.database.app.connect();
        try {
          await connection.query("BEGIN");
          await connection.query(
            "SELECT set_config('app.workspace_id',$1,true)",
            [label.workspaceId],
          );
          await assert.rejects(
            connection.query(sql, [label.workspaceId, label.id]),
            { code: "23514" },
          );
        } finally {
          await connection.query("ROLLBACK");
          connection.release();
        }
      }
      assert.equal(
        (await f.database.app.query("SELECT id FROM escalator_incident_label"))
          .rowCount,
        0,
      );
    } finally {
      await f.dispose();
    }
  },
);
