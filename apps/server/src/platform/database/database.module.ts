import { repositoryConnectionsFromJSON } from "./repository-connections.js";
import "reflect-metadata";
import { Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { workspaceIdSchema } from "@bitsentry-escalator/features/contracts";
@Injectable()
export class StandaloneDatabase implements OnApplicationShutdown {
  readonly workspaceId = workspaceIdSchema.parse(
    process.env.ESCALATOR_WORKSPACE_ID,
  );
  readonly repositoryConnections = repositoryConnectionsFromJSON(
    process.env.ESCALATOR_REPOSITORIES,
  );
  readonly pool: Pool;
  constructor() {
    const connectionString = process.env.ESCALATOR_DATABASE_URL;
    if (!connectionString)
      throw new Error("ESCALATOR_DATABASE_URL is required");
    this.pool = new Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
    this.pool.on("error", () =>
      console.error("Escalator database connection unavailable"),
    );
  }
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
@Module({ providers: [StandaloneDatabase], exports: [StandaloneDatabase] })
export class DatabaseModule {}
