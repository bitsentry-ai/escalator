import { resolve } from "node:path";
import { watchRuntimeConformance } from "@escalator-test/watch-runtime";
import { PostgresDeploymentWatchRuntimeRepository } from "../../src/platform/database/deployment-watch-runtime.repository.js";
import { PostgresConfigurationRepository } from "../../src/platform/database/configuration.repository.js";
import { PostgresWorkStore } from "../../src/platform/jobs/postgres-work.store.js";
import { readMigrations } from "../../src/platform/database/migrate.js";
import { postgresFixture, testDatabaseConfigured } from "./postgres-fixture.js";
watchRuntimeConformance(
  "standalone PostgreSQL deployment watch runtime",
  async () => {
    const database = await postgresFixture(
      await readMigrations(resolve("migrations")),
    );
    return {
      repository: new PostgresDeploymentWatchRuntimeRepository(database.app),
      configuration: new PostgresConfigurationRepository(database.app),
      work: new PostgresWorkStore(database.app),
      dispose: () => database.dispose(),
    };
  },
  testDatabaseConfigured()
    ? {}
    : {
        skip: "Not runtime-verified: configure both explicit disposable PostgreSQL test variables",
      },
);
