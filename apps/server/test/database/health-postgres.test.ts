import { resolve } from "node:path";
import { healthConformance } from "@escalator-test/health";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { PostgresHealthReader } from "../../src/platform/health/postgres-health.reader.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
healthConformance(
  "standalone operational health",
  async () => {
    const fixture = await postgresFixture(
      await readMigrations(resolve("migrations")),
    );
    return {
      ...fixture,
      reader: new PostgresHealthReader(fixture.app),
      store: new PostgresWorkStore(fixture.app),
    };
  },
  testDatabaseConfigured()
    ? {}
    : {
        skip: "Not runtime-verified: configure both Escalator PostgreSQL test database variables",
      },
);
