import { retentionPruningConformance } from "@escalator-test/retention-pruning";
import { retentionFixture } from "./retention-postgres-fixture.js";
import { testDatabaseConfigured } from "./postgres-fixture.js";
retentionPruningConformance(
  "standalone PostgreSQL retention pruning",
  retentionFixture,
  testDatabaseConfigured()
    ? {}
    : {
        skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
      },
);
