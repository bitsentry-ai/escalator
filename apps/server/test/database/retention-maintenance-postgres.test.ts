import { retentionMaintenanceConformance } from "@escalator-test/retention-maintenance";
import { retentionFixture } from "./retention-postgres-fixture.js";
import { testDatabaseConfigured } from "./postgres-fixture.js";
retentionMaintenanceConformance(
  "standalone PostgreSQL retention maintenance",
  retentionFixture,
  testDatabaseConfigured()
    ? {}
    : {
        skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
      },
);
